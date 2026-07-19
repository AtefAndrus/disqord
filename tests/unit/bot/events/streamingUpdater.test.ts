import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { Message } from "discord.js";
import { DiscordStreamingUpdater } from "../../../../src/bot/events/streamingUpdater";

/** 手動で resolve タイミングを制御できる Promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("DiscordStreamingUpdater — markFinalized", () => {
  afterEach(() => {
    // setSystemTime を書き換えたテストが実時間に戻す
    setSystemTime();
  });

  test(
    "放棄された stageContent の edit が markFinalized 後に resolve しても、" +
      "後続の新規送信は発生せず、以降の stageContent 呼び出しも no-op になる",
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      // 1メッセージの本文予算を超える長さにして、edit(既存message) → send(新規message) の
      // 2段階が発生する状況を作る（messageCreate.test.ts の bigChunk と同じ考え方）。
      const bigChunk = "x".repeat(4000);

      const editDeferred = deferred<void>();
      const initialEdit = mock(() => editDeferred.promise);
      const initialMessage = { id: "bot-1", edit: initialEdit } as unknown as Message;

      const sendMock = mock(() =>
        Promise.resolve({ id: "bot-2", edit: mock(() => Promise.resolve()) } as unknown as Message),
      );
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      // STREAM_UPDATE_INTERVAL (2秒) を経過させ、次の stageContent が実際に更新処理へ入るようにする
      setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));

      // stageContent は内部で updateStreamingMessages → 既存message の edit を待つ。
      // ここではその edit をまだ resolve させず pending のままにする。
      const stagePromise = updater.stageContent(bigChunk);

      // edit 呼び出しまでイベントループを進める（放棄された callback が生き続けている状態を模す）。
      await Promise.resolve();
      await Promise.resolve();
      expect(initialEdit).toHaveBeenCalledTimes(1);

      // 最終描画に遷移し、以降の書き込みを禁止する。
      updater.markFinalized();

      // 遅延していた edit を今 resolve する（= 放棄された callback が最終描画確定後に完了するケース）。
      editDeferred.resolve();
      await stagePromise;

      // finalized 後は、2通目に相当する新規 send（停止ボタン付きメッセージ増加）が発生しない。
      expect(sendMock).not.toHaveBeenCalled();

      // finalized 後の stageContent 呼び出しは入口で no-op になり、既存 message への追加 edit も行わない。
      initialEdit.mockClear();
      await updater.stageContent(`${bigChunk}more`);
      expect(initialEdit).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  test(
    "send() が開始済みで resolve 前に markFinalized されると、解決後そのメッセージは " +
      "botMessages に加えず best-effort で削除する",
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      // 1メッセージの本文予算を超える長さにして、edit(既存message) → send(新規message) の
      // 2段階が発生する状況を作る。
      const bigChunk = "x".repeat(4000);

      const initialEdit = mock(() => Promise.resolve());
      const initialMessage = { id: "bot-1", edit: initialEdit } as unknown as Message;

      const sendDeferred = deferred<Message>();
      const sendMock = mock(() => sendDeferred.promise);
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));
      const stagePromise = updater.stageContent(bigChunk);

      // 既存messageのeditが解決し、新規messageのsend()が呼ばれる（かつpendingのまま）ところまで
      // イベントループを進める。
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      expect(sendMock).toHaveBeenCalledTimes(1);

      // send() が Discord 側で処理中（＝呼び出し自体は開始済みで取り消せない）のうちに
      // 最終描画へ遷移する。
      updater.markFinalized();

      // send() を今 resolve する（＝開始済みの送信が finalize 後に完了するケース）。
      const deleteMock = mock(() => Promise.resolve());
      const newMessage = { id: "bot-2", delete: deleteMock } as unknown as Message;
      sendDeferred.resolve(newMessage);
      await stagePromise;

      // 解決後に届いたメッセージは botMessages に加わらず、Discord 上からも削除される。
      expect(updater.messages).toEqual([initialMessage]);
      expect(deleteMock).toHaveBeenCalledTimes(1);
    },
  );

  test(
    "1回目の edit が pending のまま、スロットル間隔経過後に呼んだ2回目の stageContent は " +
      "reconciliation を開始しない（edit/send が並行して走らない）",
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      const editDeferred = deferred<void>();
      const editMock = mock(() => editDeferred.promise);
      const initialMessage = { id: "bot-1", edit: editMock } as unknown as Message;
      const sendMock = mock(() =>
        Promise.resolve({ id: "bot-2", edit: mock() } as unknown as Message),
      );
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));
      const firstStage = updater.stageContent("first");

      await Promise.resolve();
      await Promise.resolve();
      expect(editMock).toHaveBeenCalledTimes(1);

      // スロットル間隔をさらに経過させても、1本目の reconciliation がまだ pending の間は
      // 2本目を開始しない。
      setSystemTime(new Date(2020, 0, 1, 0, 0, 4, 200));
      await updater.stageContent("second");

      expect(editMock).toHaveBeenCalledTimes(1);
      expect(sendMock).not.toHaveBeenCalled();

      editDeferred.resolve();
      await firstStage;
    },
  );

  test(
    "1本目の edit が pending のまま新しいテキストで stageContent すると、1本目 resolve 後に " +
      "最新テキストで trailing reconciliation が自動的に走る（dirty 分の取りこぼし防止）",
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      const editDeferred = deferred<void>();
      const editMock = mock(() => editDeferred.promise);
      const initialMessage = { id: "bot-1", edit: editMock } as unknown as Message;
      const sendMock = mock(() =>
        Promise.resolve({ id: "bot-2", edit: mock() } as unknown as Message),
      );
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));
      const firstStage = updater.stageContent("first");

      await Promise.resolve();
      await Promise.resolve();
      expect(editMock).toHaveBeenCalledTimes(1);

      // 1本目の reconciliation がまだ pending のうちに新しいテキストで stageContent する。
      // updateInFlight による再入判定が先に効くため、スロットル間隔を経過させなくても
      // dirty が立つだけで即座に返る（2本目はまだ開始されない）。
      await updater.stageContent("second");
      expect(editMock).toHaveBeenCalledTimes(1);

      // 1本目を resolve すると、dirty により trailing reconciliation が自動的に走り、
      // 最新テキスト（"second"）で再描画される。
      editDeferred.resolve();
      await firstStage;

      expect(editMock).toHaveBeenCalledTimes(2);
      const calls = (editMock as ReturnType<typeof mock>).mock.calls;
      const firstCallPayload = JSON.stringify(calls[0]?.[0]);
      const secondCallPayload = JSON.stringify(calls[1]?.[0]);
      expect(firstCallPayload).toContain("first");
      expect(secondCallPayload).toContain("second");
    },
  );

  test(
    "2つの pending edit をまたいで3回 stage する: 1回目の trailing はスロットルをバイパスするが、" +
      "2周目以降はスロットル未経過だと即時 edit を発生させない",
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      const editDeferreds = [deferred<void>(), deferred<void>()];
      let editCallIndex = 0;
      const editMock = mock(() => {
        const next = editDeferreds[editCallIndex] ?? deferred<void>();
        editCallIndex++;
        return next.promise;
      });
      const initialMessage = { id: "bot-1", edit: editMock } as unknown as Message;
      const sendMock = mock(() =>
        Promise.resolve({ id: "bot-2", edit: mock() } as unknown as Message),
      );
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      // 1回目の stage: スロットル間隔を経過させて実際に reconciliation (edit #1) を開始させる。
      setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));
      const firstStage = updater.stageContent("first");

      await Promise.resolve();
      await Promise.resolve();
      expect(editMock).toHaveBeenCalledTimes(1);

      // edit #1 が pending のうちに2回目 stage: updateInFlight による再入判定で dirty が立つだけ、
      // 2本目はまだ開始されない。
      await updater.stageContent("second");
      expect(editMock).toHaveBeenCalledTimes(1);

      // edit #1 を resolve する: dirty により「最初の trailing」がスロットル判定を経由せず即座に
      // 走り、edit #2 が発火する（ここまでは1回目のバイパスなので許容される挙動）。
      editDeferreds[0].resolve();
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      expect(editMock).toHaveBeenCalledTimes(2);

      // edit #2 が pending のうちに3回目 stage: 同様に dirty が立つだけで即座に返る。
      await updater.stageContent("third");
      expect(editMock).toHaveBeenCalledTimes(2);

      // edit #2 を resolve する: ここは「2周目以降の trailing」にあたるため、
      // STREAM_UPDATE_INTERVAL (2秒) が経過していない限り、3本目の edit は即座には発生しない
      // （dirty を残したままループを抜ける）。
      editDeferreds[1].resolve();
      await firstStage;

      expect(editMock).toHaveBeenCalledTimes(2);
    },
  );

  test(
    "trailing 実行中に到着した dirty が、スロットル経過後の次の通常パスへ残留せず、" +
      "同一内容の重複 edit を発生させない",
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      const editDeferreds = [deferred<void>(), deferred<void>()];
      let editCallIndex = 0;
      const editMock = mock(() => {
        const next = editDeferreds[editCallIndex];
        editCallIndex++;
        // 3回目以降の edit（今回の再現対象であるトレーリング後の通常パス、および
        // バグがあれば発生する重複パス）は即座に解決させ、テスト側での手動制御を不要にする。
        return next ? next.promise : Promise.resolve();
      });
      const initialMessage = { id: "bot-1", edit: editMock } as unknown as Message;
      const sendMock = mock(() =>
        Promise.resolve({ id: "bot-2", edit: mock() } as unknown as Message),
      );
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      // 1回目の stage: スロットル間隔を経過させて実際に reconciliation (edit #1, "first") を開始させる。
      setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));
      const firstStage = updater.stageContent("first");
      await Promise.resolve();
      await Promise.resolve();
      expect(editMock).toHaveBeenCalledTimes(1);

      // edit #1 が pending のうちに2回目 stage: dirty が立つだけで即座に返る。
      await updater.stageContent("second");
      expect(editMock).toHaveBeenCalledTimes(1);

      // edit #1 を resolve する: dirty により「最初の trailing」がスロットル判定を経由せず
      // 即座に走り、edit #2 ("second") が発火する。
      editDeferreds[0].resolve();
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      expect(editMock).toHaveBeenCalledTimes(2);

      // edit #2（trailing パス自体）が pending のうちに3回目 stage: この trailing パス
      // 「実行中」に到着した変更として dirty が立つ（実際の未描画内容）。
      await updater.stageContent("third");
      expect(editMock).toHaveBeenCalledTimes(2);

      // edit #2 を resolve する: これは2周目以降の trailing にあたり、スロットル間隔
      // (2秒) が未経過のため即座には走らず、dirty=true を残したまま reconcile() を抜ける
      // （firstStage が resolve する）。
      editDeferreds[1].resolve();
      await firstStage;
      expect(editMock).toHaveBeenCalledTimes(2);

      // スロットル間隔を経過させてから、通常の stageContent パスをもう1回実行する。
      // このパスは開始時点で `this.text`（既に "fourth"）をそのまま描画するだけで、
      // パス実行中に新たな変更は一切来ない。
      setSystemTime(new Date(2020, 0, 1, 0, 0, 4, 300));
      await updater.stageContent("fourth");

      // edit #3 ("fourth") のみが発生する。修正前は、上で残留した古い dirty=true を
      // このパスが「自分の実行中に来た変更」と誤認し、同一内容 "fourth" のまま
      // スロットルを無視した重複 edit (#4) をもう1回発生させてしまっていた。
      expect(editMock).toHaveBeenCalledTimes(3);
      const calls = (editMock as ReturnType<typeof mock>).mock.calls;
      expect(JSON.stringify(calls[2]?.[0])).toContain("fourth");
    },
  );

  test("markFinalized 後は commitTurn/abortTurn を呼んでも stageContent 経由の書き込みは再開しない", async () => {
    setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

    const editMock = mock(() => Promise.resolve());
    const initialMessage = { id: "bot-1", edit: editMock } as unknown as Message;
    const sendMock = mock(() =>
      Promise.resolve({ id: "bot-2", edit: mock() } as unknown as Message),
    );
    const originalMessage = {
      id: "trigger-1",
      channel: { id: "chan-1", send: sendMock },
    } as unknown as Message;

    const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

    updater.markFinalized();
    updater.beginTurn();
    setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));
    await updater.stageContent("hello");
    updater.commitTurn("final");

    expect(editMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test(
    'スロットル間隔内で描画がスキップされた preamble は、commitTurn("tool_calls") で' +
      "スロットルを無視して 1 回描画される",
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      const editMock = mock(() => Promise.resolve());
      const initialMessage = { id: "bot-1", edit: editMock } as unknown as Message;
      const sendMock = mock(() =>
        Promise.resolve({ id: "bot-2", edit: mock() } as unknown as Message),
      );
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      // コンストラクタ直後（lastUpdate 初期値からスロットル間隔未経過）に stageContent する:
      // 描画は一切走らず、内部テキストだけが更新される。
      updater.beginTurn();
      await updater.stageContent("preamble");
      expect(editMock).not.toHaveBeenCalled();

      // tool 呼び出しへ遷移: 未描画の preamble があるため、スロットルを無視して 1 回だけ
      // reconciliation が走り、最新テキストが反映される。
      await updater.commitTurn("tool_calls");

      expect(editMock).toHaveBeenCalledTimes(1);
      const calls = (editMock as ReturnType<typeof mock>).mock.calls;
      expect(JSON.stringify(calls[0]?.[0])).toContain("preamble");

      // 既に描画済みの内容に対して commitTurn を重ねて呼んでも、追加の edit は発生しない。
      await updater.commitTurn("tool_calls");
      expect(editMock).toHaveBeenCalledTimes(1);
    },
  );

  test(
    'commitTurn("tool_calls") 呼び出し時点で reconciliation が進行中の場合、' +
      "直接 2 本目を起動せず dirty を立てて既存の trailing 機構に委ねる",
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      const editDeferred = deferred<void>();
      const editMock = mock(() => editDeferred.promise);
      const initialMessage = { id: "bot-1", edit: editMock } as unknown as Message;
      const sendMock = mock(() =>
        Promise.resolve({ id: "bot-2", edit: mock() } as unknown as Message),
      );
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));
      const firstStage = updater.stageContent("first");

      await Promise.resolve();
      await Promise.resolve();
      expect(editMock).toHaveBeenCalledTimes(1);

      // 1本目の reconciliation (edit #1, "first") が pending のうちに commitTurn("tool_calls")
      // を呼ぶ: 2本目を直接起動せず dirty を立てるだけで即座に返る。
      const commitPromise = updater.commitTurn("tool_calls");
      expect(editMock).toHaveBeenCalledTimes(1);

      // 1本目を resolve すると dirty により trailing reconciliation が走り、
      // commit 後の最新テキスト ("first") が反映される。
      editDeferred.resolve();
      await firstStage;
      await commitPromise;

      expect(editMock).toHaveBeenCalledTimes(2);
    },
  );

  test(
    "reconciliation の edit が失敗しても lastRenderedText は更新されず、" +
      '次の commitTurn("tool_calls") で再描画が試行される',
    async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));

      let editCallCount = 0;
      const editMock = mock(() => {
        editCallCount++;
        // 1回目の edit は失敗させ、2回目以降は成功させる。
        if (editCallCount === 1) return Promise.reject(new Error("edit failed"));
        return Promise.resolve();
      });
      const initialMessage = { id: "bot-1", edit: editMock } as unknown as Message;
      const sendMock = mock(() =>
        Promise.resolve({ id: "bot-2", edit: mock() } as unknown as Message),
      );
      const originalMessage = {
        id: "trigger-1",
        channel: { id: "chan-1", send: sendMock },
      } as unknown as Message;

      const updater = new DiscordStreamingUpdater(originalMessage, initialMessage, "Model", 0);

      // スロットル間隔を経過させ、stageContent 自体が reconciliation を起動するようにする。
      setSystemTime(new Date(2020, 0, 1, 0, 0, 2, 100));
      updater.beginTurn();
      await updater.stageContent("preamble");

      // 1本目の edit が失敗している: lastRenderedText は更新されていないはず。
      expect(editMock).toHaveBeenCalledTimes(1);

      // tool 呼び出しへ遷移する。失敗した reconciliation を「描画済み」と誤認していれば
      // ここで追加の edit は発生しないが、正しく未描画として扱われていれば
      // スロットルを無視して再描画が試行される。
      await updater.commitTurn("tool_calls");

      expect(editMock).toHaveBeenCalledTimes(2);
      const calls = (editMock as ReturnType<typeof mock>).mock.calls;
      expect(JSON.stringify(calls[1]?.[0])).toContain("preamble");
    },
  );
});
