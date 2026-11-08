/**
 * Hand-written cases for `scripts/reaction-gate-eval.ts`, each a message that
 * mentions the bot and the conversation before it. `text` means the message
 * needs an answer, so a reaction alone leaves the person without one; `reaction`
 * means nothing more is needed; `either` is reported but not judged. The sets
 * are kept apart because the wording and thresholds were chosen on all but
 * `validation`, which was first run after they were fixed.
 */
export type ReactionGateLabel = "text" | "reaction" | "either";

export interface ReactionGateCase {
  id: string;
  text: string;
  label: ReactionGateLabel;
  /** The bot's last message; the question before it is in `QUESTION`. */
  bot: string;
  attachments?: { kind: "image" | "pdf" | "other"; filename: string }[];
}

export const QUESTION = "TypeScript の satisfies って何？";

const ANSWER =
  "`satisfies` は、値が型に合うかを検査しつつ、値から推論された具体的な型を保つ演算子です。型注釈と違って型を広げないので、後続のコードで具体的なプロパティをそのまま使えます。";
const OFFER =
  "`satisfies` は、値が型に合うかを検査しつつ、具体的な型を保つ演算子です。必要ならサンプルコードも書きましょうか？";
const ASKED = "TypeScript と Python のどちらで書きますか？";
const OFFER_CACHE = "原因はキャッシュのようです。キャッシュを消す手順も説明しましょうか？";
const OFFER_TWO = "修正案は 2 つあります。A は簡単で、B は安全です。どちらにしますか";
const OFFER_NEXT = "修正案を出しました。次はテストを書きますね。よろしいでしょうか。";
const STATEMENT = "修正案を出しました。これで動くはずです。";
const CLOSER =
  "satisfies は型を広げずに検査する演算子です。他に知りたいことがあれば聞いてくださいね。";
const CLOSER_QUESTION = "以上が手順です。ほかに質問はありますか？";
const CLOSER_REPORT = "修正しました。動かなければ教えてください！";
const OFFER_EXAMPLE =
  "設定ファイルの timeout を増やすと直るはずです。書き換え例も用意しましょうか？";
const OFFER_COMMANDS = "まず依存を更新するのがよさそうです。実行するコマンドをまとめますか？";
const ASKED_LOG = "原因は 2 つ考えられます。ログを見せてもらえますか？";
const OFFER_IF = "もし必要なら、PR の説明文も書きます。";
const SETTING = "timeout を増やすと直ります。設定は config.yml の 3 行目です。";
const DONE = "ログの 12 行目が原因です。これで解決するはずです。お疲れさまでした！";
const STEPS = "修正の手順は以上です。ほかに困っていることがあれば言ってください。";

/** Longer than the judgment state keeps of a message, so only what follows it decides the case. */
const LONG_BODY =
  "`satisfies` は TypeScript 4.9 で入った演算子で、値が指定した型に合うかをコンパイル時に検査します。型注釈との違いは、注釈が値の型を指定した型へ広げてしまうのに対して、`satisfies` は値から推論された具体的な型をそのまま保つ点です。たとえば設定オブジェクトに使うと、キーの打ち間違いを検出しつつ、後続のコードでは各プロパティの具体的な型を使えます。`as` は検査を弱めて開発者の主張を通す書き方なので、誤りを隠すことがあります。一方で `satisfies` は検査だけを行い、型は変えません。実行時の振る舞いには影響せず、出力される JavaScript には残りません。既存のコードへ導入するときは、まず型注釈を付けている箇所のうち、後続で具体的な型が欲しい箇所から置き換えるのが無難です。ライブラリの公開 API のように、型を広げておきたい箇所では型注釈のままで構いません。".repeat(
    2,
  );
const LONG_OFFER = `${LONG_BODY}必要ならサンプルコードも書きましょうか？`;
const LONG_OFFER_TEST = `${LONG_BODY}この方針でテストも追加しますか？`;
const LONG_DONE = `${LONG_BODY}以上です。`;
const OFFER_PLAN = "今日の予定は 3 件です。空き時間もまとめましょうか？";
const ASKED_LANGUAGE = "どの言語で書きますか？";
const REGISTERED = "登録しました。";

const label =
  (kind: ReactionGateLabel) =>
  (id: string, text: string, bot = ANSWER): ReactionGateCase => ({ id, text, label: kind, bot });
const t = label("text");
const r = label("reaction");
const e = label("either");

export const REACTION_GATE_SETS: Record<string, ReactionGateCase[]> = {
  hard: [
    t("offer-yes", "はい", OFFER),
    t("offer-please", "お願いします", OFFER),
    t("offer-un", "うん", OFFER),
    t("offer-yoroshiku", "よろしく", OFFER),
    t("offer-thanks-please", "ありがとう、お願い", OFFER),
    t("asked-ts", "TypeScript で", ASKED),
    t("asked-any", "どっちでも", ASKED),
    t("asked-py", "py", ASKED),
    t("thanks-but", "ありがとう、でもそれ違うと思う"),
    t("thanks-still", "ありがとう、ただ as と何が違うのかがまだ分からない"),
    t("ack-request", "了解、じゃあテストも書いて"),
    t("ok-next", "OK、次は実例を見せて"),
    t(
      "long-buried",
      "本当に助かりました。おかげでバグも直りました。ところでこの書き方って古いバージョンでも動きますか",
    ),
    t("en-thanks-why", "thanks, but why?"),
    t("en-example", "can you show an example?"),
    t("really", "ほんとに？"),
    t("why", "え、なんで"),
    t("so", "つまり？"),
    t("continue", "続けて"),
    t("more", "もっと詳しく"),
    t("example", "例は？"),
    t("others", "他には？"),
    t("meaning", "どういうこと"),
    t("qmark", "？"),
    t("old", "それって古くない？"),
    t("en-why", "why?"),
    t("lost", "全然わからん"),
    t("ironic-lost", "なるほど、全然わからん"),
    t("wrong", "違う、そうじゃない"),
    t("not-as", "いや as の話じゃなくて"),
    r("thanks", "ありがとう、助かった！"),
    r("thanks-en", "thanks!"),
    r("ty", "ty"),
    r("thanks-long", "本当に助かりました。おかげでバグも直りました！"),
    r("solved", "動いた！ありがとう"),
    r("solved-2", "解決しました"),
    r("ack", "了解です"),
    r("ok", "OK"),
    r("oke", "おけ"),
    r("haai", "はーい"),
    r("naruhodo", "なるほど"),
    r("tashikani", "たしかに"),
    r("sorena", "それな"),
    r("kusa", "草"),
    r("www", "www"),
    r("sugoi", "すごい"),
    r("kami", "神"),
    r("emoji-up", "👍"),
    r("emoji-pray", "🙏"),
    r("night", "おやすみ"),
    r("good", "いい感じ！"),
    e("hello", "こんにちは"),
    e("tired", "疲れた"),
    e("react-ask", "👍つけて"),
    e("insult", "使えないな"),
    e("hmm", "うーん"),
    e("seriously", "まじで？"),
    e("hee", "へー"),
  ],
  holdout: [
    t("o-tanomu", "頼む", OFFER),
    t("o-zehi", "ぜひ", OFFER),
    t("o-sorede", "じゃあそれで", OFFER),
    t("o-yatte", "いいね、やって", OFFER),
    t("o-kaite", "書いて", OFFER),
    t("o-hai-please", "はい、それでお願いします", OFFER),
    t("o-negai", "おねがい！", OFFER),
    t("o-kudasai", "ください", OFFER),
    t("a-mae", "前者", ASKED),
    t("a-py", "Python がいい", ASKED),
    t("a-ue", "上のやつ", ASKED),
    t("url", "https://x.com/foo/status/123"),
    t("code", "```\nconst a = 1 satisfies number\n```"),
    t("kore", "これどう"),
    t("oshiete", "教えて"),
    t("tsuzuki", "続き"),
    t("kekkyoku", "で、結局どっち"),
    t("as-wa", "じゃあ as は？"),
    t("error", "なんかエラー出た"),
    t("broken", "動かないんだけど"),
    t("arigato-en", "ありがとうって英語で何？"),
    t("keigo", "『ありがとう』を敬語にして"),
    t("ruigo", "了解の類語は？"),
    t("imi", "なるほどってどういう意味"),
    t("mouikkai", "もう一回"),
    t("honyaku", "翻訳して"),
    t("thx-nothing", "thx for nothing, that didn't work"),
    t("thanks-then", "ありがとう。で、次どうすればいい？"),
    t("sorry-what", "ごめん、もう一回説明して"),
    t("try", "試したけどダメだった"),
    r("thankyou-kata", "サンキュー"),
    r("azasu", "あざす"),
    r("kansha", "感謝"),
    r("ok-k", "おk"),
    r("ryo", "りょ"),
    r("haaku", "把握"),
    r("shochi", "承知しました"),
    r("fumu", "ふむふむ"),
    r("benkyo", "へえ、勉強になった"),
    r("sokoka", "なるほど、そういうことか"),
    r("tasukaru", "助かる"),
    r("nice", "ナイス"),
    r("sasuga", "さすが"),
    r("wara", "笑"),
    r("lol", "lol"),
    r("nice-en", "nice"),
    r("gotit", "got it"),
    r("cool", "cool"),
    r("otsu", "お疲れさま"),
    r("ashita", "また明日"),
    r("rikai", "理解した"),
    r("kanpeki", "完璧"),
    r("o-decline", "大丈夫です、ありがとう", OFFER),
    r("o-iranai", "いらないです、ありがとう", OFFER),
    e("o-no", "いいえ", OFFER),
    e("o-ok", "大丈夫です", OFFER),
    e("onaka", "お腹すいた"),
    e("hehe", "ふーん"),
    e("mumu", "むむ"),
    e("bot-praise", "君賢いね"),
    e("ganbaru", "がんばるわ"),
  ],
  // Short replies accepting an offer, which read as acknowledgements on their own.
  accept: [
    t("c-ok", "OK", OFFER),
    t("c-ryokai", "了解", OFFER),
    t("c-iiyo", "いいよ", OFFER),
    t("c-makaseta", "任せた", OFFER),
    t("c-yoshinani", "よしなに", OFFER),
    t("c-okke", "おっけー", OFFER),
    t("c-tasukaru", "助かる", OFFER),
    t("c-arigatai", "ありがたい", OFFER),
    t("c-tanonda", "頼んだ", OFFER),
    t("c-yoroshiku2", "よろしくお願いします", OFFER),
    t("c-yoroshiku3", "よろしくー", OFFER),
    t("c-yoroshiku4", "よろ", OFFER),
    t("c-sure", "sure", OFFER),
    t("c-yes", "yes please", OFFER),
    t("c-maa", "まあお願い", OFFER),
    t("c-sou", "そうして", OFFER),
    t("c-sorede", "それで", OFFER),
    t("c-aa", "あ、じゃあ", OFFER),
    t("c2-ok", "OK", OFFER_CACHE),
    t("c2-yoroshiku", "よろしく", OFFER_CACHE),
    t("c2-tanomu", "お願い", OFFER_CACHE),
    t("c2-iine", "いいね", OFFER_CACHE),
    t("c2-ryokai", "了解", OFFER_CACHE),
    t("c3-a", "A", OFFER_TWO),
    t("c3-ok", "おまかせ", OFFER_TWO),
    t("c3-yoroshiku", "安全な方でよろしく", OFFER_TWO),
    t("c4-ok", "OK", OFFER_NEXT),
    t("c4-yoroshiku", "よろしく", OFFER_NEXT),
    t("c4-hai", "はい", OFFER_NEXT),
    r("s-ok", "OK", STATEMENT),
    r("s-ryokai", "了解", STATEMENT),
    r("s-yoroshiku", "よろしく", STATEMENT),
    r("s-thanks", "ありがとう", STATEMENT),
    r("s-iine", "いいね", STATEMENT),
    r("s-tasukaru", "助かる", STATEMENT),
  ],
  // The polite closing lines models end on: not an offer, so thanks to them is still only thanks.
  closer: [
    r("cl-thanks", "ありがとう", CLOSER),
    r("cl-tasukatta", "助かった！", CLOSER),
    r("cl-ryokai", "了解", CLOSER),
    r("cl-naruhodo", "なるほど", CLOSER),
    r("cl2-thanks", "ありがとう", CLOSER_QUESTION),
    r("cl2-nai", "大丈夫です、ありがとう", CLOSER_QUESTION),
    r("cl2-tasukatta", "助かった", CLOSER_QUESTION),
    r("cl2-nai2", "ないです", CLOSER_QUESTION),
    r("cl2-ok", "OK", CLOSER_QUESTION),
    r("cl3-thanks", "ありがとう、試してみる", CLOSER_REPORT),
    r("cl3-ok", "おけ", CLOSER_REPORT),
  ],
  unseen: [
    t("f-p1-ok", "OK", OFFER_EXAMPLE),
    t("f-p1-ryokai", "了解です", OFFER_EXAMPLE),
    t("f-p1-ure", "嬉しい", OFFER_EXAMPLE),
    t("f-p1-yoro", "よろしくです", OFFER_EXAMPLE),
    t("f-p1-sasuga", "さすが、よろしく", OFFER_EXAMPLE),
    t("f-p1-ii", "いいですね", OFFER_EXAMPLE),
    t("f-p1-aza", "あざす、頼みます", OFFER_EXAMPLE),
    t("f-p1-nn", "んー、じゃあ", OFFER_EXAMPLE),
    t("f-p2-hai", "はいー", OFFER_COMMANDS),
    t("f-p2-matomete", "まとめて", OFFER_COMMANDS),
    t("f-p2-tasukarimasu", "助かります", OFFER_COMMANDS),
    t("f-p2-ok", "おk", OFFER_COMMANDS),
    t("f-p3-log", "これです\nERROR: connection refused", ASKED_LOG),
    t("f-p3-hai", "はい", ASKED_LOG),
    e("f-p3-matte", "ちょっと待って、今出す", ASKED_LOG),
    t("f-p4-negai", "お願いしようかな", OFFER_IF),
    t("f-p4-ja", "じゃあ頼む", OFFER_IF),
    t("f-p4-kaite", "書いといて", OFFER_IF),
    t("f-q1", "config.yml ってどこにあるの", SETTING),
    t("f-q2", "3 行目がないんだけど", SETTING),
    t("f-q3", "増やすってどのくらい？", SETTING),
    t("f-q4", "直らなかった", SETTING),
    t("f-q5", "別のやり方ある？", SETTING),
    t("f-q6", "それ本番でもやっていいやつ？", SETTING),
    t("f-q7", "ありがとう！ついでに README も直して", SETTING),
    t("f-q8", "了解、でもその前に原因教えて", SETTING),
    t("f-q9", "なるほど。で、なんで timeout なの", SETTING),
    t("f-q10", "なるほどね、でもそれだと遅くならない？", SETTING),
    t("f-q11", "めっちゃ助かる、あと 1 個だけ聞いていい？", SETTING),
    t("f-q12", "OK、それやったら次どうなる？", SETTING),
    t("f-q13", "え", SETTING),
    t("f-q14", "あれ、違うエラーになった", SETTING),
    t("f-q15", "Summarize this for me", SETTING),
    t("f-q16", "thanks. what about the second line?", SETTING),
    r("f-r1", "ありがとうございます！", SETTING),
    r("f-r2", "直りました、ありがとう", SETTING),
    r("f-r3", "おー、いけた", SETTING),
    r("f-r4", "なるほどねー", SETTING),
    r("f-r5", "完全に理解した", SETTING),
    r("f-r6", "助かりました", SETTING),
    r("f-r7", "thx", SETTING),
    r("f-r8", "perfect, thanks!", SETTING),
    r("f-r9", "天才", SETTING),
    r("f-r10", "ありがとー！めちゃくちゃ助かった", SETTING),
    r("f-s2-1", "お疲れさまです、ありがとう", DONE),
    r("f-s2-2", "やったー", DONE),
    r("f-s2-3", "おつ", DONE),
    r("f-s3-1", "ありがとう、今のところ大丈夫", STEPS),
    r("f-s3-2", "今は大丈夫です", STEPS),
    r("f-s3-3", "ありがと", STEPS),
  ],
  // First run with `needs_text` at 0.3 and `accepts` at 0.45. `accepts` then moved to 0.4 for the
  // other sets; that can only turn a reaction into text, so it cannot add a wrong result here.
  validation: [
    t("v-l-ryokai", "了解", LONG_OFFER),
    t("v-l-yoroshiku", "よろしく", LONG_OFFER),
    t("v-l-tasukaru", "助かる", LONG_OFFER),
    t("v-l-please", "お願いします", LONG_OFFER),
    t("v-l-ok", "OK", LONG_OFFER),
    t("v-l-iine", "いいね", LONG_OFFER),
    t("v-l-hai", "はい", LONG_OFFER),
    t("v-l-ureshii", "嬉しい", LONG_OFFER_TEST),
    t("v-l-sorede", "それで", LONG_OFFER_TEST),
    t("v-l2-q1", "3 番目の意味がわからない", LONG_DONE),
    t("v-l2-q2", "要約して", LONG_DONE),
    t("v-l2-q3", "なんで 2 つあるの", LONG_DONE),
    t("v-l2-q4", "もっと短くして", LONG_DONE),
    r("v-l2-thanks", "ありがとう", LONG_DONE),
    r("v-l2-naruhodo", "なるほど", LONG_DONE),
    r("v-l2-tasukatta", "助かった", LONG_DONE),
    r("v-l2-ryokai", "了解", LONG_DONE),
    r("v-l2-oo", "おー", LONG_DONE),
    r("v-l2-rikai", "理解できた", LONG_DONE),
    r("v-l2-yonda", "読んだ、ありがとう", LONG_DONE),
    r("v-l2-ok", "OK", LONG_DONE),
    r("v-l2-sugo", "すご", LONG_DONE),
    t("v-o-shimasu", "おねがいしまーす", OFFER_PLAN),
    t("v-o-tanomuwa", "頼むわ", OFFER_PLAN),
    t("v-o-tasukaruwa", "助かるわ", OFFER_PLAN),
    t("v-o-hoshii", "ほしい", OFFER_PLAN),
    t("v-o-un", "うん、ほしい", OFFER_PLAN),
    t("v-o-okplease", "ok please", OFFER_PLAN),
    t("v-o-yoki", "よき", OFFER_PLAN),
    t("v-a-rust", "Rust", ASKED_LANGUAGE),
    t("v-a-nandemo", "なんでもいい", ASKED_LANGUAGE),
    t("v-a-omakase", "お任せ", ASKED_LANGUAGE),
    t("v-a-js", "JS で", ASKED_LANGUAGE),
    r("v-r-thx", "サンクス", REGISTERED),
    r("v-r-aritoo", "ありがとー", REGISTERED),
    r("v-r-haai", "はーい", REGISTERED),
    r("v-r-okke", "おっけ", REGISTERED),
    r("v-r-tasukaru", "たすかるー", REGISTERED),
    r("v-r-arigatai", "ありがたい", REGISTERED),
    r("v-r-alot", "thanks a lot", REGISTERED),
    r("v-r-smile", "😊", REGISTERED),
    r("v-r-heart", "❤️", REGISTERED),
    r("v-r-wakatta", "わかった", REGISTERED),
    t("v-q-free", "これ無料？", REGISTERED),
    t("v-q-time", "今何時", REGISTERED),
    t("v-q-back", "前の話に戻るけど", REGISTERED),
    t("v-q-gone", "あれ、消えた", REGISTERED),
    t("v-q-ask", "ちょっと聞きたいんだけど", REGISTERED),
    t("v-q-off", "なんか違くない", REGISTERED),
    t("v-q-sorry", "ごめん、どういう意味", REGISTERED),
    t("v-q-detail", "詳細", REGISTERED),
    t("v-q-limit", "thanks. also, what's the limit?", REGISTERED),
    e("v-e-chinami", "ちなみに", REGISTERED),
    e("v-e-hmm", "ふむ", REGISTERED),
    e("v-e-hai", "はい", REGISTERED),
    e("v-e-maji", "まじか", REGISTERED),
  ],
};
