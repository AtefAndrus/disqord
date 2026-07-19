import type { Message } from "discord.js";
import type { IToolLoopUpdater } from "../../llm/toolLoop";
import type { ToolRenderPayload } from "../../llm/tools/registry";
import {
  badgeText,
  buildStreamingContainer,
  measureTextBudget,
  STREAMING_LABEL,
  splitTextIntoMessages,
  toComponentsV2EditPayload,
  toComponentsV2Payload,
} from "../../utils/chatContainerBuilder";
import { logger } from "../../utils/logger";

const STREAM_UPDATE_INTERVAL = 2000; // 2秒

/**
 * message の Section（停止ボタン）を isLast: true で再 edit し、復元を試みる。
 * message 増加遷移中に send/edit が失敗し、停止ボタンがどこにも無い状態のまま次 chunk 到着まで
 * 固まる（無期限にキャンセル不能になる）のを防ぐための best-effort 処理。
 * 復元自体の失敗も warn ログのみで無視する（次サイクルで自己修復を試みる）。
 *
 * `isFinalized` は、呼び出し元がこの処理を開始した後に最終描画（final/cancelled/error）へ遷移した
 * 場合に true を返す。ここでの edit は最終描画確定後には無意味（かつ停止ボタン付きメッセージを
 * 蘇らせてしまう）ため、実行前に再チェックして no-op にする。
 */
async function restoreStreamingSection(
  botMessage: Message,
  text: string,
  isFirst: boolean,
  modelName: string,
  color: number,
  triggerMessageId: string,
  isFinalized: () => boolean,
): Promise<void> {
  if (isFinalized()) return;
  try {
    const container = buildStreamingContainer({
      text,
      modelName,
      color,
      isFirst,
      isLast: true,
      triggerMessageId,
    });
    await botMessage.edit(toComponentsV2EditPayload(container));
  } catch (restoreError) {
    logger.warn("Failed to restore stop button section on stripped message", {
      restoreError,
      messageId: botMessage.id,
    });
  }
}

/**
 * ストリーミング中のメッセージを更新する。
 * 長文の場合は複数メッセージに分割し、停止ボタン（Section）は最新メッセージのみに配置する。
 * edit/send の失敗（429 等）は throw させず、当該サイクルの残り処理を break で打ち切って次サイクルへ
 * 委ねる（discord.js 内蔵の rate limit queue に基本委ねる）。失敗した message より後ろを触らずに
 * 打ち切ることで「停止ボタンは常に高々 1 個」の不変条件を守る（例: message[0] の Section 除去 edit が
 * 失敗した状態で message[1] の send だけ成功すると停止ボタンが 2 個になってしまう）。次サイクルで全
 * message が再 edit されるため自己修復する。
 *
 * message 増加遷移（1→2 等）では、旧末尾 message から Section を先に外してから新 message を send する
 * ため、その send が失敗すると停止ボタンがどこにも無い状態になり、次 chunk 到着まで（ストールすれば
 * 無期限に）キャンセル不能になってしまう。これを避けるため、旧末尾 message 以降で「isLast: false へ
 * edit/send 済み（＝ Section を失ったまま）」の最新 index を追跡し、break する前に best-effort で
 * その message へ Section を復元する。edit 自体の失敗による break（旧末尾 message にまだ触れていない
 * ケース）は対象外とする — 実末尾 message には前サイクルの Section が残っており、ボタンは可用のまま。
 *
 * `isFinalized` は、この呼び出しの実行中に最終描画（final/cancelled/error）へ遷移したかを返す。
 * 放棄された（timeout/cancel で await が打ち切られた）呼び出しがそのまま生き続け、最終描画確定後に
 * 遅れて edit/send を行うと、確定済み表示を stale な内容や停止ボタン付きメッセージで上書きしてしまう
 * ため、await を挟むたびに再チェックし、finalized 後は以降の send/edit を一切行わない。
 * 特に send() は「開始済みの呼び出しは取り消せない」ため、解決を待っている間に finalized へ
 * 遷移すると、この関数が isFinalized() を見る前に Discord 上へ新規メッセージが実在してしまう。
 * その場合は botMessages に加えず（最終描画側の管理対象にしない）、停止ボタン付きメッセージが
 * 残置されないよう best-effort で削除する。
 *
 * 戻り値は `fullText` を実際に描画し終えたかどうかを表す（呼び出し元が「描画済み」を判定する材料に
 * するため）。途中の edit/send が失敗して break した場合や、finalized/送信後 finalized 検知で
 * 早期 return した場合は `false` を返す（一部の message だけ成功した部分的成功も安全側で `false`
 * 扱いにする）。全 chunk の edit/send が完了しきった場合のみ `true` を返す。
 */
async function updateStreamingMessages(
  botMessages: Message[],
  fullText: string,
  modelName: string,
  color: number,
  originalMessage: Message,
  isFinalized: () => boolean,
): Promise<boolean> {
  if (isFinalized()) return false;

  const chunks = splitTextIntoMessages(
    fullText,
    measureTextBudget(badgeText(modelName)),
    measureTextBudget(STREAMING_LABEL),
  );

  // 前サイクルまで Section（停止ボタン）を保持していた message の index
  const oldLastIndex = botMessages.length - 1;
  // 旧末尾以降で Section を失ったまま留まっている最新の message index（未発生なら null）
  let sectionLostAtIndex: number | null = null;

  for (let i = 0; i < chunks.length; i++) {
    if (isFinalized()) return false;

    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const container = buildStreamingContainer({
      text: chunks[i],
      modelName,
      color,
      isFirst,
      isLast,
      triggerMessageId: originalMessage.id,
    });

    try {
      if (i < botMessages.length) {
        await botMessages[i].edit(toComponentsV2EditPayload(container));
        if (isFinalized()) return false;
      } else if ("send" in originalMessage.channel) {
        const newMessage = await originalMessage.channel.send(toComponentsV2Payload(container));
        if (isFinalized()) {
          // send() 解決を待つ間に最終描画へ遷移した: このメッセージは botMessages に加えず
          // （最終描画側の管理下に置かない）、Discord 上にも停止ボタン付きメッセージとして
          // 残らないよう best-effort で削除する。削除失敗はここでは復旧不能なため warn のみ。
          try {
            await newMessage.delete();
          } catch (deleteError) {
            logger.warn("Failed to delete a message sent after finalize", {
              deleteError,
              messageId: newMessage.id,
            });
          }
          return false;
        }
        botMessages.push(newMessage);
      }

      if (i >= oldLastIndex) {
        sectionLostAtIndex = isLast ? null : i;
      }
    } catch (error) {
      logger.warn("Failed to update streaming message, aborting this cycle to retry next cycle", {
        error,
        index: i,
      });

      if (
        !isFinalized() &&
        sectionLostAtIndex !== null &&
        sectionLostAtIndex < botMessages.length
      ) {
        await restoreStreamingSection(
          botMessages[sectionLostAtIndex],
          chunks[sectionLostAtIndex],
          sectionLostAtIndex === 0,
          modelName,
          color,
          originalMessage.id,
          isFinalized,
        );
      }
      // 一部の message だけ成功していても（例: message[0] は edit できたが message[1] の send が
      // 失敗した）、`fullText` 全体は描画し終えていないため安全側で false を返す。
      return false;
    }
  }
  return true;
}

/**
 * `runToolLoop()` が駆動する `IToolLoopUpdater` の Discord 実装。
 *
 * 状態:
 * - `committedText`: 確定済み過去ターン（`commitTurn("tool_calls")` された preamble）のテキスト。
 * - `currentTurnText`: 進行中ターンの暫定テキスト（`stageContent` が渡す累積値をそのまま保持）。
 * - `botMessages`: 現在このリクエストが所有する bot message 群（1→N に増減しうる）。
 *
 * `messages` / `text` / `elapsedSeconds` は最終描画・停止表示・致命的エラー時のクリーンアップを
 * messageCreate 側が組み立てるために公開している（`ToolLoopResult` の状態分岐後、Discord への
 * 実際の書き込みは基本的に messageCreate 側の責務）。
 *
 * `markFinalized()`: `runToolLoop()` の updater 呼び出しは timeout/cancel で await を打ち切りうるが
 * （`invokeUpdater` 参照）、打ち切られても呼び出し自体は継続して実行中であり、放棄後に stageContent の
 * edit/send が遅れて解決することがある。何もしなければ、最終描画（final/cancelled/error）を
 * messageCreate 側が確定させた後に、この遅延した呼び出しが停止ボタン付きの stale な内容で Discord を
 * 上書きしうる。`markFinalized()` はその最終描画の直前に呼ばれ、以降 stageContent とその内部の
 * 非同期送信/編集ループを恒久的に no-op 化する。
 *
 * `updateInFlight`: reconciliation（`updateStreamingMessages` の実行）は直列化する。edit/send が
 * ハングした状態のまま次の stageContent 呼び出しがスロットル間隔を超えると、2 本の reconciliation が
 * 同時に botMessages を触り、古い内容での上書きや重複 send を起こしうるため、1 本目が完了するまで
 * 2 本目は開始しない。開始を見送られたチャンクの内容は失われず、`this.text`（常に最新の状態を返す
 * getter）を次回の reconciliation が読むことで反映される。
 *
 * `dirty`: 「次回の reconciliation が読む」だけでは、その「次回」が二度と来ないケースがある —
 * 現在進行中の reconciliation が最後の stageContent 呼び出しであり、以降 tool_calls でターンが
 * 終わってしまう場合、`this.text` に反映された最新テキストは誰にも読まれず、実行中の
 * reconciliation が読んだ時点の古い内容が Discord 上に長時間（次の運が良ければ来る stageContent
 * まで）残ってしまう。`dirty` は updateInFlight 中に来た stageContent を記録し、実行中の
 * reconciliation 完了直後に 1 回だけスロットルを無視した trailing reconciliation を挟むことで、
 * 「最後に staged された内容が必ずいずれ描画される」を保証する。
 *
 * `lastRenderedText`: 直近の reconciliation が実際に送信/編集を完了した時点の `this.text`
 * スナップショット。`updateStreamingMessages()` が edit/send の失敗で `false`（未完了）を返した
 * パスでは更新しない — 更新してしまうと、実際には古い表示のまま Discord 上に残っているのに
 * 「描画済み」と誤認され、後述の `commitTurn("tool_calls")` の再描画判定がスキップされてしまう。
 * スロットルで stageContent の描画がスキップされたまま `commitTurn("tool_calls")`（tool 実行への
 * 遷移）が来ると、`dirty` も次の stageContent もこの先しばらく来ない（tool 実行中は何も staged
 * されない）ため、未描画の preamble が tool 実行が終わるまで Discord 上に残ってしまう。
 * `commitTurn("tool_calls")` はこのフィールドと `this.text` を比較し、未描画分があればスロットルを
 * 無視して 1 回 reconciliation を実行する（updateInFlight 中なら `dirty` を立てて既存の trailing
 * 機構に委ねる — 2 本の reconciliation を同時に走らせない直列化を崩さないため）。
 */
export class DiscordStreamingUpdater implements IToolLoopUpdater {
  private readonly startTime = Date.now();
  private readonly botMessages: Message[];
  private committedText = "";
  private currentTurnText = "";
  private lastUpdate = Date.now();
  private finalized = false;
  private updateInFlight = false;
  private dirty = false;
  /** `this.text` snapshot as of the most recent reconciliation attempt (see class doc). */
  private lastRenderedText = "";

  constructor(
    private readonly originalMessage: Message,
    initialBotMessage: Message,
    private readonly modelName: string,
    private readonly color: number,
  ) {
    this.botMessages = [initialBotMessage];
  }

  /** 現在の bot message 群（最終描画・停止表示・エラークリーンアップのため messageCreate へ公開）。 */
  get messages(): Message[] {
    return this.botMessages;
  }

  /** これまでに受信した全テキスト（確定済み過去ターン + 現ターンの暫定分）。 */
  get text(): string {
    return this.committedText + this.currentTurnText;
  }

  /** リクエスト開始（このインスタンス構築）からの経過秒数。停止時の footer 表示に使う。 */
  get elapsedSeconds(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * 最終描画（final/cancelled/error のいずれか）の直前に呼ぶ。以降、放棄された古い updater 呼び出しが
   * 遅れて解決しても Discord への書き込みを一切行わない。
   */
  markFinalized(): void {
    this.finalized = true;
  }

  beginTurn(): void {
    this.currentTurnText = "";
  }

  async stageContent(text: string): Promise<void> {
    // finalized/updateInFlight のいずれでも内部テキストだけは更新する: 描画はスキップされても
    // 内容は失わず、次に開始される reconciliation が `this.text` 経由で最新分をまとめて反映する。
    this.currentTurnText = text;
    if (this.finalized) return;
    if (this.updateInFlight) {
      // 実行中の reconciliation は開始時点の `this.text` しか送信/編集内容に反映しない。
      // このまま return すると、この呼び出しの内容は「次に開始される reconciliation」に
      // 委ねられるが、その「次」がスロットルや残りターン数の都合で永遠に来ないことがある。
      // 完了直後に trailing で 1 回拾い直すためのマーカーとして立てておく。
      this.dirty = true;
      return;
    }

    const now = Date.now();
    if (now - this.lastUpdate < STREAM_UPDATE_INTERVAL) return;

    // ここ（reconciliation 開始時）で打つ: 完了時点で打つと、edit/send がハングしている間
    // スロットルが機能せず、後続の stageContent が updateInFlight だけを頼りに際限なく
    // 再入判定することになる。開始時点で打てば、ハング中でも次の呼び出しは
    // updateInFlight で弾かれるため二重の防御になる。
    this.lastUpdate = now;
    await this.reconcile();
  }

  /**
   * `updateStreamingMessages()` を 1 回実行し、完了後に `dirty` が立っていれば
   * （＝実行中に取りこぼした stageContent があれば）trailing として最初の 1 回だけスロットル判定を
   * 経由せずもう 1 回実行する。2 周目以降の trailing は `STREAM_UPDATE_INTERVAL` の経過を要求し、
   * 未経過なら `dirty` を残したままループを抜ける — edit 完了ごとに際限なく Discord edit が連発する
   * のを防ぐため（残った内容は後続の stageContent か最終描画で反映される。ストリーム継続中は
   * 後続チャンクが必ず来るため取り残しは一時的）。
   * 各周回の開始前に `finalized` を再チェックする（`updateStreamingMessages` 自身も内部で
   * チェックするが、trailing 実行そのものを起動しないことでループの終了を保証する）。
   */
  private async reconcile(): Promise<void> {
    let bypassedThrottleOnce = false;
    while (true) {
      // 各パス開始直前にスナップショットとしてクリアする: `this.text` は常にその時点の最新
      // 累積テキストを返すため、これから始まるパスは（まだ何も stage されていなくても）現時点の
      // 最新内容を描画する。以前のパス（今回とは別の reconcile() 呼び出しかもしれない）で
      // updateInFlight 中に立った dirty をここまで持ち越すと、その古い dirty が「今回のパス実行中に
      // 変更が来た」と誤認されて、実際には変更のない内容へ同一内容の throttle-bypass edit を
      // もう1回発生させてしまう。dirty はこのパスの実行中に到着した変更だけを表すようにする。
      this.dirty = false;
      this.updateInFlight = true;
      const snapshotText = this.text;
      try {
        const rendered = await updateStreamingMessages(
          this.botMessages,
          snapshotText,
          this.modelName,
          this.color,
          this.originalMessage,
          () => this.finalized,
        );
        // Only recorded when `updateStreamingMessages()` actually finished
        // rendering `snapshotText` (see its own doc comment): a failed/partial
        // pass must leave `lastRenderedText` stale so `commitTurn("tool_calls")`'s
        // comparison against `this.text` still detects the unrendered content
        // and retries, instead of mistaking the failure for "already drawn".
        if (rendered) {
          this.lastRenderedText = snapshotText;
        }
      } finally {
        this.updateInFlight = false;
      }

      if (this.finalized || !this.dirty) return;

      if (bypassedThrottleOnce) {
        const now = Date.now();
        if (now - this.lastUpdate < STREAM_UPDATE_INTERVAL) return; // dirty を残したまま抜ける
        this.lastUpdate = now;
      } else {
        bypassedThrottleOnce = true;
        this.lastUpdate = Date.now();
      }
    }
  }

  commitTurn(kind: "tool_calls" | "final"): void | Promise<void> {
    if (kind === "tool_calls") {
      // preamble を確定し、以降の tool ブロック/次ターンの土台にする。
      this.committedText += this.currentTurnText;
      this.currentTurnText = "";

      if (this.finalized) return;

      if (this.updateInFlight) {
        // 実行中の reconciliation が読んだスナップショットには、今 committed した preamble が
        // 反映されていないかもしれない。ここで2本目の reconciliation を起動すると
        // botMessages への同時書き込みで直列化が崩れるため、既存の trailing 機構（dirty）に委ねる。
        this.dirty = true;
        return;
      }

      if (this.text === this.lastRenderedText) return; // 既に描画済み: 何もしない

      // スロットルで描画がスキップされたまま tool 実行フェーズへ入ると、preamble が
      // tool 実行の間ずっと古い表示のまま残ってしまう。ここではスロットルを無視して
      // 1 回だけ reconciliation を実行し、確実に反映する。
      this.lastUpdate = Date.now();
      return this.reconcile();
    }
    // "final": 最終描画は messageCreate 側が ToolLoopResult (status: "final") を見て行う。
    // ここで追加の Discord 書き込みをすると二重描画になるため何もしない。
  }

  abortTurn(_reason: string): void {
    // 当該ターンの内容は「確定した過去ターン」(committedText) には含めない。ただし Discord 上に
    // 既に出ている暫定表示はそのまま残し、ここでは追加の描画を行わない — 停止/エラー時の最終表示は
    // messageCreate 側が `this.text`（暫定分を含む）を読んで組み立てる。
  }

  beginToolBlock(_name: string): void {
    // 現段階では tool が登録されていないため到達しない。将来 tool 実行中インジケータ等の
    // 描画フックをここに実装する。
  }

  endToolBlock(_name: string, _render?: ToolRenderPayload): void {
    // 同上。将来 tool 実行結果の描画フックをここに実装する。
  }
}
