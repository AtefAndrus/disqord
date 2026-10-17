/**
 * Hand-written reply-gate cases for `scripts/reply-gate-eval.ts`. `expect`
 * is true when the bot should answer. Each history line is `<author>: <text>`
 * and a line by `BOT_NAME` is the bot's own reply. The `hard` set puts the
 * surface cue and the right answer on opposite sides: a bot-shaped question
 * addressed to one person, a question only a human can answer, a question
 * that follows thanks to the bot.
 */
export interface ReplyGateCase {
  id: string;
  expect: boolean;
  history: string[];
  current: string;
  replyTarget?: string;
  attachments?: { kind: "image" | "pdf" | "other"; filename: string }[];
}

export const BOT_NAME = "DisQord";

const smalltalk = [
  "たろう: 昨日のアプデ入れた？",
  "じろう: まだ。重いって聞いた",
  "はなこ: うちは普通に動いてる",
  "たろう: グラボによるのかな",
  "じろう: かもね。週末やるわ",
  "はなこ: 新マップ広すぎて迷った",
  "たろう: わかる、地図ほしい",
  "じろう: 攻略サイトにあったよ",
  "はなこ: 後で見てみる",
  "たろう: そういえば来週の飲み会どこだっけ",
  "じろう: 駅前の居酒屋",
  "はなこ: 19時からだよね",
];

const easy: ReplyGateCase[] = [
  // --- should stay silent ---
  {
    id: "s-chat-continue",
    expect: false,
    history: [
      "たろう: 今日の昼なに食べた？",
      "はなこ: ラーメン。駅前の新しい店",
      "たろう: いいな、今度行こう",
    ],
    current: "はなこ: うん、土曜とかどう？",
  },
  {
    id: "s-thanks-to-bot",
    expect: false,
    history: ["たろう: DisQord、明日の東京の天気わかる？", `${BOT_NAME}: 晴れのち曇りの予報です。`],
    current: "たろう: ありがと",
  },
  {
    id: "s-ask-human-by-name",
    expect: false,
    history: ["たろう: 週末のゲーム会どうする？", "じろう: 俺は土曜なら行ける"],
    current: "たろう: はなこはどう？土曜いける？",
  },
  {
    id: "s-lol",
    expect: false,
    history: ["じろう: 昨日駅で転んだ", "はなこ: 大丈夫？"],
    current: "たろう: ｗｗｗ",
  },
  {
    id: "s-humans-on-bot-answer",
    expect: false,
    history: [
      "たろう: DisQord、おすすめのキーボード教えて",
      `${BOT_NAME}: 静電容量無接点方式の HHKB などが人気です。`,
      "じろう: HHKB 高くない？",
    ],
    current: "はなこ: 高いけど一生使えるって言うよね",
  },
  {
    id: "s-greeting",
    expect: false,
    history: ["じろう: おはよー", "はなこ: おはよう"],
    current: "たろう: おはー、眠い",
  },
  {
    id: "s-ack-plan",
    expect: false,
    history: ["じろう: じゃあ 19 時に改札前集合で", "はなこ: OK"],
    current: "たろう: 了解",
  },
  {
    id: "s-share-pet-photo",
    expect: false,
    history: ["はなこ: 猫飼い始めた", "じろう: まじ？見せて"],
    current: "はなこ: この子",
    attachments: [{ kind: "image", filename: "cat.jpg" }],
  },
  {
    id: "s-human-answered",
    expect: false,
    history: [
      "たろう: git で直前のコミットメッセージ直すのどうやるんだっけ",
      "じろう: git commit --amend だよ",
    ],
    current: "たろう: なるほど、ありがと",
  },
  {
    id: "s-bot-third-person",
    expect: false,
    history: ["じろう: さっき DisQord に聞いたら変な答え返ってきた", "はなこ: たまにあるよね"],
    current: "たろう: DisQord ってたまにズレたこと言うよね笑",
  },
  {
    id: "s-complaint",
    expect: false,
    history: ["じろう: 明日から仕事か", "はなこ: やだー"],
    current: "たろう: 月曜まじで無理",
  },
  {
    id: "s-human-answer-cont",
    expect: false,
    history: [
      "たろう: Docker のコンテナがすぐ落ちるんだけど",
      "じろう: ログ見た？ docker logs で出るよ",
    ],
    current: "じろう: あと、compose の restart 設定も見直した方がいい",
  },
  {
    id: "s-reply-to-human",
    expect: false,
    history: ["じろう: 新作の映画、思ったより良かった", "はなこ: 主演の人の演技がすごかった"],
    replyTarget: "はなこ: 主演の人の演技がすごかった",
    current: "たろう: それな",
  },
  {
    id: "s-vc-call",
    expect: false,
    history: ["じろう: 今日ひま", "はなこ: 私も"],
    current: "たろう: 今から VC 入れる人いる？",
  },
  {
    id: "s-react-bot-joke",
    expect: false,
    history: [
      "たろう: DisQord、何か面白い話して",
      `${BOT_NAME}: プログラマーが海に行かない理由は、C が怖いからです。`,
    ],
    current: "じろう: ｗｗ確かに",
  },
  {
    id: "s-emoji-only",
    expect: false,
    history: [
      "はなこ: DisQord、1 ドルって今何円くらい？",
      `${BOT_NAME}: 直近ではおよそ 150 円前後です。`,
    ],
    current: "はなこ: 👍",
  },
  {
    id: "s-give-up-bot",
    expect: false,
    history: [
      "たろう: DisQord、この関数の計算量わかる？",
      `${BOT_NAME}: ループが二重なので O(n^2) です。`,
      "たろう: うーん、ちょっと違う気がする",
    ],
    current: "たろう: やっぱ自分で調べるわ",
  },
  {
    id: "s-banter",
    expect: false,
    history: [
      "じろう: お前またガチャ回したのか",
      "たろう: 天井まであと少しだったんだよ",
      "はなこ: 沼ってるｗ",
      "じろう: 来月の家賃大丈夫？",
    ],
    current: "たろう: 大丈夫じゃない",
  },
  {
    id: "s-at-human",
    expect: false,
    history: ["はなこ: 明日の会議の資料まだ？", "たろう: 今作ってる"],
    current: "はなこ: @じろう 明日の資料送った？",
  },
  {
    id: "s-share-link",
    expect: false,
    history: ["じろう: 最近のニュース見た？", "はなこ: 何の？"],
    current: "じろう: https://example.com/news/123 これやばくない？",
  },
  {
    id: "s-moved-on",
    expect: false,
    history: [
      "たろう: DisQord、パスタの茹で時間の目安は？",
      `${BOT_NAME}: 袋の表示どおりが基本で、多くは 8〜10 分です。`,
      "はなこ: 今日の夜ご飯どうする？",
      "たろう: パスタにしようかな",
      "はなこ: いいね、一緒に作ろう",
    ],
    current: "たろう: 7 時でいい？",
  },
  {
    id: "s-goodnight",
    expect: false,
    history: ["じろう: そろそろ寝る", "はなこ: おつかれ"],
    current: "たろう: おやすみー",
  },
  { id: "s-long-chat", expect: false, history: smalltalk, current: "たろう: じゃあ 19 時に駅前ね" },
  {
    id: "s-english-lol",
    expect: false,
    history: ["mike: my cat knocked my coffee over again", "じろう: classic"],
    current: "はなこ: lol same",
  },

  // --- should reply ---
  {
    id: "r-ask-bot-by-name",
    expect: true,
    history: ["たろう: 今日の昼なに食べた？", "はなこ: ラーメン"],
    current: "はなこ: ねえ DisQord、駅前から一番近い大きい公園ってどう探せばいい？",
  },
  {
    id: "r-followup-to-bot",
    expect: true,
    history: [
      "たろう: DisQord、TypeScript で配列を重複なしにする方法ある？",
      `${BOT_NAME}: new Set を使って [...new Set(arr)] とするのが簡単です。`,
    ],
    current: "たろう: オブジェクトの配列だとどうなる？",
  },
  {
    id: "r-open-question-room",
    expect: true,
    history: ["たろう: Rust の勉強始めた", "はなこ: おー"],
    current: "たろう: 所有権とか借用ってどういう概念なんだろ、誰か説明できる？",
  },
  {
    id: "r-request-summary",
    expect: true,
    history: [
      "たろう: 仕様どうする？",
      "じろう: A 案だとコストが高い",
      "はなこ: B 案は実装が大変",
      "たろう: うーん",
    ],
    current: "じろう: ここまでの議論まとめてくれる人いない？",
  },
  {
    id: "r-fact-dispute",
    expect: true,
    history: ["たろう: 富士山って 3776m だっけ", "じろう: 3778m じゃなかった？"],
    current: "たろう: どっちが正しいんだろ",
  },
  {
    id: "r-reply-bot-what",
    expect: true,
    history: [
      "じろう: DisQord、TCP と UDP の違いって？",
      `${BOT_NAME}: TCP は到達と順序を保証し、UDP は保証しない代わりに軽量です。`,
    ],
    replyTarget: `${BOT_NAME}: TCP は到達と順序を保証し、UDP は保証しない代わりに軽量です。`,
    current: "じろう: どういうこと？",
  },
  {
    id: "r-reply-bot-more",
    expect: true,
    history: [
      "はなこ: DisQord、ポモドーロ・テクニックって何？",
      `${BOT_NAME}: 25 分集中して 5 分休むのを繰り返す時間管理法です。`,
    ],
    replyTarget: `${BOT_NAME}: 25 分集中して 5 分休むのを繰り返す時間管理法です。`,
    current: "はなこ: もう少し詳しく",
  },
  {
    id: "r-error-paste",
    expect: true,
    history: ["たろう: React 触ってる"],
    current:
      "たろう: TypeError: Cannot read properties of undefined (reading 'map') ってエラー出るんだけど何これ",
  },
  {
    id: "r-translate",
    expect: true,
    history: ["はなこ: 海外の取引先にメール書いてる"],
    current: "はなこ: 「お疲れさまです」って英語でなんて言えばいい？",
  },
  {
    id: "r-weather-room",
    expect: true,
    history: ["じろう: 明日出かける", "たろう: どこ行くの"],
    current: "じろう: 誰か明日の東京の天気知ってる？",
  },
  {
    id: "r-error-image",
    expect: true,
    history: ["たろう: ビルドが通らない"],
    current: "たろう: このエラーの意味わかる人いる？",
    attachments: [{ kind: "image", filename: "error.png" }],
  },
  {
    id: "r-bot-opinion",
    expect: true,
    history: [
      "たろう: 朝型と夜型どっちがいいと思う？",
      "じろう: 夜型一択",
      "はなこ: 朝型の方が健康的でしょ",
    ],
    current: "たろう: DisQord はどう思う？",
  },
  {
    id: "r-followup-recipe",
    expect: true,
    history: [
      "はなこ: DisQord、簡単なカレーのレシピ教えて",
      `${BOT_NAME}: 4 人分で、玉ねぎ 2 個、にんじん 1 本、じゃがいも 2 個、肉 300g、ルー半箱です。`,
    ],
    current: "はなこ: それ 2 人分だと分量どうなる？",
  },
  {
    id: "r-calc",
    expect: true,
    history: ["じろう: セールやってる"],
    current: "じろう: 1980 円の 15% オフっていくら？計算して",
  },
  {
    id: "r-correct-bot",
    expect: true,
    history: [
      "たろう: DisQord、Python で distutils 使う方法教えて",
      `${BOT_NAME}: from distutils.core import setup と書いて使います。`,
    ],
    replyTarget: `${BOT_NAME}: from distutils.core import setup と書いて使います。`,
    current: "たろう: いや、それ違くない？ Python 3.12 だと動かないよ",
  },
  {
    id: "r-long-then-name",
    expect: true,
    history: smalltalk,
    current: "はなこ: ところで DisQord、最近おすすめの SF 小説ある？",
  },
  {
    id: "r-long-then-open",
    expect: true,
    history: smalltalk,
    current: "じろう: 話変わるけど、量子コンピュータって結局何がすごいの？誰か簡単に教えて",
  },
  {
    id: "r-earlier-bot-ref",
    expect: true,
    history: [
      "たろう: DisQord、Python でファイルを 1 行ずつ読むコード書いて",
      `${BOT_NAME}: with open(path) as f:\n    for line in f:\n        print(line)`,
      "じろう: Python いいよね",
      "はなこ: 私は Go 派",
    ],
    current: "たろう: あ、さっきのやつ Go でも書ける？",
  },
  {
    id: "r-summarize-pdf",
    expect: true,
    history: ["じろう: 会議の資料もらった"],
    current: "じろう: これ 3 行で要約して",
    attachments: [{ kind: "pdf", filename: "report.pdf" }],
  },
  {
    id: "r-term-meaning",
    expect: true,
    history: ["たろう: PR 出したよ", "じろう: 見とく"],
    current: "はなこ: 横からごめん、LGTM ってどういう意味？",
  },
  {
    id: "r-regex",
    expect: true,
    history: ["たろう: フォームのバリデーション作ってる"],
    current: "たろう: 誰か正規表現詳しい人いる？メールアドレスにマッチさせたい",
  },
  {
    id: "r-english-ask",
    expect: true,
    history: ["mike: hi all"],
    current: "mike: DisQord can you explain what a monad is?",
  },
  {
    id: "r-reply-bot-opinion",
    expect: true,
    history: [
      "はなこ: DisQord、在宅勤務のメリットは？",
      `${BOT_NAME}: 通勤時間がなくなり、集中しやすい環境を作れることです。`,
    ],
    replyTarget: `${BOT_NAME}: 通勤時間がなくなり、集中しやすい環境を作れることです。`,
    current: "はなこ: デメリットもある？",
  },
];

const hard: ReplyGateCase[] = [
  // --- should stay silent ---
  {
    id: "hs-topic-to-human",
    expect: false,
    history: ["たろう: Rust 難しい", "じろう: 慣れるまでだよ、俺は半年かかった"],
    current: "たろう: じろう、所有権ってどういう概念？前に勉強してたよね",
  },
  {
    id: "hs-translate-to-human",
    expect: false,
    history: ["はなこ: 英語の歌詞で意味わからないとこある"],
    current: "はなこ: @じろう この英文訳せる？ 'break a leg'",
  },
  {
    id: "hs-anyone-free",
    expect: false,
    history: ["たろう: 週末ひま", "はなこ: 私は日曜なら"],
    current: "たろう: 誰か土曜ひまな人いる？",
  },
  {
    id: "hs-meeting-content",
    expect: false,
    history: ["じろう: 昨日休んでた", "はなこ: 熱だったんでしょ、大丈夫？"],
    current: "じろう: うん。誰か昨日の定例出た人いる？何話した？",
  },
  {
    id: "hs-rhetorical",
    expect: false,
    history: ["たろう: 今週長すぎる", "はなこ: まだ水曜…"],
    current: "じろう: なんで水曜ってこんなに長いんだろ",
  },
  {
    id: "hs-poll-friends",
    expect: false,
    history: ["はなこ: お菓子買ってきた"],
    current: "はなこ: みんな、きのこ派？たけのこ派？",
  },
  {
    id: "hs-human-offer",
    expect: false,
    history: ["たろう: Git のリベース怖い", "じろう: あとで教えるよ、簡単だから"],
    current: "たろう: 今教えて",
  },
  {
    id: "hs-self-talk",
    expect: false,
    history: ["たろう: 朝からずっとバグってる"],
    current: "たろう: よし、今日中にこのバグ直すぞ",
  },
  {
    id: "hs-code-review-human",
    expect: false,
    history: ["じろう: PR レビューお願いしていい？"],
    current: "じろう: はなこ、この関数のロジック見てくれる？ `if (a && !b || c) return;`",
  },
  {
    id: "hs-ask-bot-suggest",
    expect: false,
    history: ["たろう: 正規表現の書き方わからん"],
    current: "じろう: DisQord に聞いてみたら？",
  },
  {
    id: "hs-naruhodo-late",
    expect: false,
    history: [
      "はなこ: DisQord、HTTP/3 って何？",
      `${BOT_NAME}: QUIC という UDP ベースのプロトコル上で動く HTTP の新しい版です。`,
      "じろう: QUIC 速いらしいね",
      "はなこ: へー",
    ],
    current: "たろう: なるほど",
  },
  {
    id: "hs-human-explains",
    expect: false,
    history: [
      "はなこ: SSH の鍵ってどう作るの？",
      "じろう: ssh-keygen ってコマンドがある",
      "じろう: -t ed25519 を付けるのがおすすめ",
    ],
    current: "はなこ: それって Windows でも使える？",
  },
  {
    id: "hs-bot-name-in-story",
    expect: false,
    history: ["たろう: 昨日の夜、DisQord に小説の続き書かせてた", "はなこ: どうだった？"],
    current: "たろう: 意外と面白かった、DisQord 結構やるね",
  },
  {
    id: "hs-question-mid-human-thread",
    expect: false,
    history: [
      "じろう: 新しいノート PC 買った",
      "たろう: どれ？",
      "じろう: 14 インチの軽いやつ",
      "たろう: メモリいくつ？",
      "じろう: 16GB",
    ],
    current: "たろう: SSD は？",
  },
  {
    id: "hs-thanks-plus-chat",
    expect: false,
    history: ["はなこ: DisQord、明日の降水確率は？", `${BOT_NAME}: 明日の降水確率は 20% です。`],
    current: "はなこ: ありがと！じゃあ傘いらないね、じろう",
  },

  // --- should reply ---
  {
    id: "hr-thanks-then-q",
    expect: true,
    history: [
      "はなこ: DisQord、「ありがとう」を韓国語で？",
      `${BOT_NAME}: 「감사합니다（カムサハムニダ）」です。`,
    ],
    current: "はなこ: ありがと！ちなみに中国語だと？",
  },
  {
    id: "hr-confused-after-bot",
    expect: true,
    history: [
      "じろう: DisQord、再帰関数って何？",
      `${BOT_NAME}: 関数の中で自分自身を呼び出す関数です。終了条件が必要です。`,
    ],
    current: "じろう: うーん、よくわからん",
  },
  {
    id: "hr-second-user-asks",
    expect: true,
    history: [
      "たろう: DisQord、おすすめの Linux ディストリは？",
      `${BOT_NAME}: 初心者なら Ubuntu が情報も多くおすすめです。`,
    ],
    current: "はなこ: 私も質問いい？ Mac で Docker 動かすのに一番軽い方法は？",
  },
  {
    id: "hr-summarize-url",
    expect: true,
    history: ["じろう: 長い記事見つけた", "たろう: 読む時間ない"],
    current: "たろう: 誰かこのページ要約して https://example.com/long-article",
  },
  {
    id: "hr-doubt-bot",
    expect: true,
    history: ["たろう: DisQord、日本で一番長い川は？", `${BOT_NAME}: 利根川です。`],
    replyTarget: `${BOT_NAME}: 利根川です。`,
    current: "たろう: 信濃川じゃなかった？",
  },
  {
    id: "hr-after-human-stuck",
    expect: true,
    history: [
      "はなこ: SQL で重複行だけ消す方法ある？",
      "じろう: うーん、わからん",
      "たろう: 俺も知らない",
    ],
    current: "はなこ: 誰か詳しい人いないかな",
  },
  {
    id: "hr-bot-earlier-ambiguous-followup",
    expect: true,
    history: [
      "じろう: DisQord、おすすめのタスク管理アプリある？",
      `${BOT_NAME}: Todoist や TickTick が使いやすいです。`,
      "はなこ: 私は紙派",
      "たろう: 紙いいよね",
    ],
    current: "じろう: Todoist って無料で使える？",
  },
  {
    id: "hr-implicit-request",
    expect: true,
    history: ["たろう: 明日プレゼンなんだけど"],
    current: "たろう: 自己紹介の一言目が思いつかない、何かいい案ない？",
  },
  {
    id: "hr-math-check",
    expect: true,
    history: ["じろう: 割り勘するよ", "はなこ: 合計 12,800 円で 3 人"],
    current: "じろう: 1 人いくら？端数どうしよ",
  },
  {
    id: "hr-reply-bot-short",
    expect: true,
    history: ["はなこ: DisQord、カフェインの半減期は？", `${BOT_NAME}: 一般に 4〜6 時間程度です。`],
    replyTarget: `${BOT_NAME}: 一般に 4〜6 時間程度です。`,
    current: "はなこ: 個人差ある？",
  },
  {
    id: "hr-image-ask",
    expect: true,
    history: ["じろう: 公園で見つけた"],
    current: "じろう: この植物の名前わかる人いる？",
    attachments: [{ kind: "image", filename: "plant.jpg" }],
  },
  {
    id: "hr-bot-nick",
    expect: true,
    history: ["たろう: 暇だなー"],
    current: "たろう: bot くん、何かおすすめの映画教えて",
  },
  {
    id: "hr-long-human-then-fact",
    expect: true,
    history: [
      "たろう: 昨日のアプデ入れた？",
      "じろう: まだ。重いって聞いた",
      "はなこ: うちは普通に動いてる",
      "たろう: グラボによるのかな",
      "じろう: かもね",
    ],
    current: "はなこ: そもそも VRAM って何に使われてるの？",
  },
  {
    id: "hr-continue-code",
    expect: true,
    history: [
      "たろう: DisQord、JavaScript で配列をシャッフルする関数書いて",
      `${BOT_NAME}: Fisher-Yates 法で書けます。for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }`,
    ],
    current: "たろう: TypeScript で型付けて",
  },
  {
    id: "hr-english-room",
    expect: true,
    history: ["mike: anyone here good with CSS?", "じろう: not really"],
    current: "mike: how do I center a div vertically?",
  },
];

export const replyGateCases: ReplyGateCase[] = [...easy, ...hard];
