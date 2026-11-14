---------------------------- MODULE SessionSync ----------------------------
(***************************************************************************)
(* 画面のセッションの同期（ADR 0012）のモデル。                            *)
(*                                                                         *)
(* UserDO（apps/web/src/server/user-do.ts）が記録を変えるたびに、HTTP の   *)
(* 応答と WebSocket の同期メッセージ（SessionChanged）の両方でスナップショット*)
(* が届く。届く順は入れ替わりうる。画面（client/use-session-timer.ts と    *)
(* client/snapshot-arrival.ts）は SessionSnapshot.isOlder                 *)
(* （domain/session.ts）でサーバーの時刻が古いものを捨てる。               *)
(*                                                                         *)
(* スナップショットは [t |-> サーバーの時刻, v |-> 何番目の変更までを含むか]*)
(* で表す。v は実装にはない、検査のための値（同じ v なら同じ記録）。       *)
(* 時刻はミリ秒そのものではなく、大小の順だけを残した小さな整数。          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, Bags, FiniteSets, TLC

CONSTANTS
    Screens,       \* 画面（タブ・端末）。各画面が同期の WebSocket を1本張る（client/use-sync.ts）
    MaxChanges,    \* 画面が送る書き込み（操作・記入）の数の上限
    WithWrites,    \* TRUE なら、操作のほかに記入・進め方の変更（Write）も送る
    MaxLosses,     \* HTTP の要求・応答が失われる（画面には Unreachable が返る）数の上限
    MaxDisconnects,\* WebSocket が切れる数の上限
    MaxClock,      \* Tick で進める時刻の上限（ClockStalls = TRUE のとき）
    ClockStalls,   \* TRUE: 時計は実時間で進み（Tick）、同時に届いた要求は同じミリ秒に処理されうる
                   \*       （Workers の時計は I/O まで止まる）
                   \* FALSE: UserDO が要求を処理するたびに時計が進む（同じミリ秒に2つの要求はない）
    Mutation,      \* 検査が落ちることを確かめるための、わざと壊した実装（"None" なら壊さない）
    Fixes          \* 見つかった問題の直し方の候補の集合。実装にはまだない（{} なら実装のとおり）

ASSUME Mutation \in {"None", "IsOlderReversed", "NoOverlapCheck",
                     "NoRefreshOnConnect", "ChangeKeepsClock"}
\* HoldSyncWhileLoading: 読み込めていない間に届いた同期メッセージを捨てず、読み込めてから反映する
ASSUME Fixes \subseteq {"HoldSyncWhileLoading"}

NoSnap == [t |-> 0, v |-> 0]   \* まだ何も受け取っていない画面の shown（Loaded でなければ読まない）

\* domain/session.ts の SessionSnapshot.isOlder
IsOlder(received, current) ==
    IF Mutation = "IsOlderReversed"
    THEN received.t > current.t
    ELSE received.t < current.t

VARIABLES
    clock,      \* UserDO の new Date()（user-do.ts の #run）
    ver,        \* UserDO の記録が何回変わったか
    phase,      \* 同期の WebSocket の様子（client/sync-connection.ts の Phase）
                \*   "Connecting": 開いた。UserDO はまだ受け入れていない
                \*   "Accepted":   UserDO が受け入れた（acceptWebSocket）。画面はまだ open を受け取っていない
                \*   "Open":       画面が open を受け取った
                \*   "Waiting":    切れて、繋ぎ直しを待っている
    wsq,        \* 画面ごとの WebSocket の届いていないメッセージ。1本の接続の中では順に届く
    httpReq,    \* 画面ごとの、UserDO にまだ届いていない HTTP の要求（Bag。どの順でも届く）
    httpRes,    \* 画面ごとの、画面にまだ届いていない HTTP の応答（Bag。どの順でも届く）
    loading,    \* use-session-timer.ts の Loading の kind
    shown,      \* Loaded のときの received.snapshot
    inFlight,   \* operation-overlap.ts の inFlight
    gen,        \* operation-overlap.ts の generation
    sending,    \* use-session-timer.ts の send の途中か（pending）。"Idle" / "Sending"
    changes,    \* これまでに送った書き込みの数（上限のため）
    losses,     \* これまでに HTTP の要求・応答が失われた数（上限のため）
    disconnects,\* これまでに WebSocket が切れた数（上限のため）
    lastIssued  \* 検査用: UserDO が最後に出したスナップショット

vars == <<clock, ver, phase, wsq, httpReq, httpRes, loading, shown, inFlight,
          gen, sending, changes, losses, disconnects, lastIssued>>

Bag1(x) == SetToBag({x})
Add(b, x) == b (+) Bag1(x)
Remove(b, x) == b (-) Bag1(x)

\* 要求を送った時刻。ClockStalls = TRUE のとき、要求は送った時刻より後（1ms 以上あと）に処理される。
\* ClockStalls = FALSE なら使わない（状態を増やさないよう 0 にする）
SentAt == IF ClockStalls THEN clock ELSE 0

OpReq == [kind |-> "Op", sentAt |-> SentAt]
WriteReq == [kind |-> "Write", sentAt |-> SentAt]
LoadReq(token, cause) == [kind |-> "Load", token |-> token, cause |-> cause, sentAt |-> SentAt]
\* 読み込みを送り始める（operation-overlap.ts の readStarted）
TokenOf(fl, g) == [busy |-> fl > 0, gen |-> g]

-----------------------------------------------------------------------------
Init ==
    /\ clock = 1
    /\ ver = 0
    \* 画面を開くと同期の WebSocket を開き（use-sync.ts）、読み込みを始める（use-session-timer.ts の useEffect）
    /\ phase = [s \in Screens |-> "Connecting"]
    /\ wsq = [s \in Screens |-> <<>>]
    /\ httpReq = [s \in Screens |->
                    Bag1([kind |-> "Load", token |-> TokenOf(0, 0), cause |-> "Refresh", sentAt |-> 0])]
    /\ httpRes = [s \in Screens |-> EmptyBag]
    /\ loading = [s \in Screens |-> "Loading"]
    /\ shown = [s \in Screens |-> NoSnap]
    /\ inFlight = [s \in Screens |-> 0]
    /\ gen = [s \in Screens |-> 0]
    /\ sending = [s \in Screens |-> "Idle"]
    /\ changes = 0
    /\ losses = 0
    /\ disconnects = 0
    /\ lastIssued = NoSnap

\* use-session-timer.ts の applyReceived（snapshot-arrival.ts）
ApplyReceived(s, snap) ==
    IF loading[s] = "Loaded" /\ IsOlder(snap, shown[s])
    THEN UNCHANGED <<loading, shown>>
    ELSE /\ loading' = [loading EXCEPT ![s] = "Loaded"]
         /\ shown' = [shown EXCEPT ![s] = snap]

-----------------------------------------------------------------------------
(* 画面の操作                                                              *)

\* 開始・操作のボタン（use-session-timer.ts の start / operate → send）。
\* 送っている途中はボタンを押せない（pending）。operations.begin()
Operate(s) ==
    /\ loading[s] = "Loaded"
    /\ sending[s] = "Idle"
    /\ changes < MaxChanges
    /\ sending' = [sending EXCEPT ![s] = "Sending"]
    /\ inFlight' = [inFlight EXCEPT ![s] = @ + 1]
    /\ gen' = [gen EXCEPT ![s] = @ + 1]
    /\ httpReq' = [httpReq EXCEPT ![s] = Add(@, OpReq)]
    /\ changes' = changes + 1
    /\ UNCHANGED <<clock, ver, phase, wsq, httpRes, loading, shown, losses, disconnects, lastIssued>>

\* ジャーナル記入や進め方の変更（timeline / advance-mode の API）。応答はスナップショットではなく、
\* 成功したら timer.refresh() で読み込み直す（home-page.tsx）。operations は数えない
Write(s) ==
    /\ WithWrites
    /\ loading[s] = "Loaded"
    /\ changes < MaxChanges
    /\ httpReq' = [httpReq EXCEPT ![s] = Add(@, WriteReq)]
    /\ changes' = changes + 1
    /\ UNCHANGED <<clock, ver, phase, wsq, httpRes, loading, shown, inFlight, gen,
                   sending, losses, disconnects, lastIssued>>

\* 「読み込み直す」ボタン（timer-panel.tsx。LoadFailed のときだけ出る）
Reload(s) ==
    /\ loading[s] = "LoadFailed"
    /\ loading' = [loading EXCEPT ![s] = "Loading"]
    /\ httpReq' = [httpReq EXCEPT ![s] = Add(@, LoadReq(TokenOf(inFlight[s], gen[s]), "Refresh"))]
    /\ UNCHANGED <<clock, ver, phase, wsq, httpRes, shown, inFlight, gen, sending,
                   changes, losses, disconnects, lastIssued>>

-----------------------------------------------------------------------------
(* UserDO。要求は1つずつ処理する（Durable Object は要求を直列にする）       *)

\* 時計が進む。ClockStalls = FALSE のときは Serve が進めるので、Tick は使わない
Tick ==
    /\ ClockStalls
    /\ clock < MaxClock
    /\ clock' = clock + 1
    /\ UNCHANGED <<ver, phase, wsq, httpReq, httpRes, loading, shown, inFlight, gen,
                   sending, changes, losses, disconnects, lastIssued>>

\* 今の時刻で req を処理してよいか。送ってから UserDO に届くまでに 1ms 以上かかる
CanServeNow(req) == ~ClockStalls \/ clock > req.sentAt

\* 要求を処理したあとの時計
ClockAfterServe(changed) ==
    IF ClockStalls
    THEN clock' = clock
    ELSE clock' = IF Mutation = "ChangeKeepsClock" /\ changed THEN clock ELSE clock + 1

\* user-do.ts の #broadcast。受け入れた接続（getWebSockets）すべてへ送る
Broadcast(snap) ==
    wsq' = [s \in Screens |->
              IF phase[s] \in {"Accepted", "Open"} THEN Append(wsq[s], snap) ELSE wsq[s]]

\* POST /api/session, POST /api/session/commands（startSession / operateSession → #execute）
\* 受け付けられれば記録を変え、同期メッセージを送ってから応答を返す。
\* 断られる（409 など）ときは何も変えない
ServeOp(s, req, ok) ==
    LET snap == [t |-> clock, v |-> ver + 1]
    IN
    /\ BagIn(req, httpReq[s])
    /\ req.kind = "Op"
    /\ CanServeNow(req)
    /\ httpReq' = [httpReq EXCEPT ![s] = Remove(@, req)]
    /\ IF ok
       THEN /\ ver' = ver + 1
            /\ Broadcast(snap)
            /\ lastIssued' = snap
            /\ httpRes' = [httpRes EXCEPT ![s] = Add(@, [kind |-> "Op", result |-> "Ok", snap |-> snap])]
            /\ ClockAfterServe(TRUE)
       ELSE /\ httpRes' = [httpRes EXCEPT ![s] = Add(@, [kind |-> "Op", result |-> "Rejected"])]
            /\ ClockAfterServe(FALSE)
            /\ UNCHANGED <<ver, wsq, lastIssued>>
    /\ UNCHANGED <<phase, loading, shown, inFlight, gen, sending, changes, losses, disconnects>>

\* POST /api/journal-entries など。記録を変え、SessionChanged を送る（workflows/user-commands.ts）
ServeWrite(s, req) ==
    LET snap == [t |-> clock, v |-> ver + 1]
    IN
    /\ BagIn(req, httpReq[s])
    /\ req.kind = "Write"
    /\ CanServeNow(req)
    /\ httpReq' = [httpReq EXCEPT ![s] = Remove(@, req)]
    /\ ver' = ver + 1
    /\ Broadcast(snap)
    /\ lastIssued' = snap
    /\ httpRes' = [httpRes EXCEPT ![s] = Add(@, [kind |-> "Write", result |-> "Ok"])]
    /\ ClockAfterServe(TRUE)
    /\ UNCHANGED <<phase, loading, shown, inFlight, gen, sending, changes, losses, disconnects>>

\* GET /api/session/current（getCurrentSession → #run）
ServeLoad(s, req) ==
    LET snap == [t |-> clock, v |-> ver]
    IN
    /\ BagIn(req, httpReq[s])
    /\ req.kind = "Load"
    /\ CanServeNow(req)
    /\ httpReq' = [httpReq EXCEPT ![s] = Remove(@, req)]
    /\ lastIssued' = snap
    /\ httpRes' = [httpRes EXCEPT ![s] =
                     Add(@, [kind |-> "Load", result |-> "Ok", snap |-> snap,
                             token |-> req.token, cause |-> req.cause])]
    /\ ClockAfterServe(FALSE)
    /\ UNCHANGED <<ver, phase, wsq, loading, shown, inFlight, gen, sending, changes, losses, disconnects>>

\* GET /api/ws（user-do.ts の fetch → acceptWebSocket）。これより後の同期メッセージがこの接続に届く
Accept(s) ==
    /\ phase[s] = "Connecting"
    /\ phase' = [phase EXCEPT ![s] = "Accepted"]
    /\ wsq' = [wsq EXCEPT ![s] = <<>>]
    /\ UNCHANGED <<clock, ver, httpReq, httpRes, loading, shown, inFlight, gen, sending,
                   changes, losses, disconnects, lastIssued>>

-----------------------------------------------------------------------------
(* 画面が受け取る                                                          *)

\* sync-connection.ts の onOpen → use-sync.ts の onConnected → timer.refresh()
Opened(s) ==
    /\ phase[s] = "Accepted"
    /\ phase' = [phase EXCEPT ![s] = "Open"]
    /\ httpReq' = IF Mutation = "NoRefreshOnConnect"
                  THEN httpReq
                  ELSE [httpReq EXCEPT ![s] = Add(@, LoadReq(TokenOf(inFlight[s], gen[s]), "Refresh"))]
    /\ UNCHANGED <<clock, ver, wsq, httpRes, loading, shown, inFlight, gen, sending,
                   changes, losses, disconnects, lastIssued>>

\* SessionChanged が届く（use-sync.ts の deliver → timer.receive）。読み込めていなければ捨てる。
\* Fixes に HoldSyncWhileLoading があれば、読み込めるまで受け取らずに待たせる
ReceiveSync(s) ==
    /\ phase[s] = "Open"
    /\ wsq[s] /= <<>>
    /\ "HoldSyncWhileLoading" \in Fixes => loading[s] = "Loaded"
    /\ LET snap == Head(wsq[s]) IN
         IF loading[s] = "Loaded"
         THEN ApplyReceived(s, snap)
         ELSE UNCHANGED <<loading, shown>>
    /\ wsq' = [wsq EXCEPT ![s] = Tail(@)]
    /\ UNCHANGED <<clock, ver, phase, httpReq, httpRes, inFlight, gen, sending, changes,
                   losses, disconnects, lastIssued>>

\* 開始・操作の応答（use-session-timer.ts の send）。operations.end() のあと、
\* 成功なら反映し、断られたら読み込み直し（load）、届かなければ（Unreachable）何もしない
ReceiveOp(s, res) ==
    /\ BagIn(res, httpRes[s])
    /\ res.kind = "Op"
    /\ httpRes' = [httpRes EXCEPT ![s] = Remove(@, res)]
    /\ inFlight' = [inFlight EXCEPT ![s] = @ - 1]
    /\ gen' = [gen EXCEPT ![s] = @ + 1]
    /\ CASE res.result = "Ok" ->
              /\ ApplyReceived(s, res.snap)
              /\ sending' = [sending EXCEPT ![s] = "Idle"]
              /\ UNCHANGED httpReq
         [] res.result = "Rejected" ->
              \* pending は読み込みが終わるまで続く（await load()）
              /\ httpReq' = [httpReq EXCEPT ![s] =
                               Add(@, LoadReq(TokenOf(inFlight'[s], gen'[s]), "AfterSend"))]
              /\ UNCHANGED <<loading, shown, sending>>
         [] res.result = "Unreachable" ->
              /\ sending' = [sending EXCEPT ![s] = "Idle"]
              /\ UNCHANGED <<httpReq, loading, shown>>
    /\ UNCHANGED <<clock, ver, phase, wsq, changes, losses, disconnects, lastIssued>>

\* 記入などの応答。成功したら timer.refresh()
ReceiveWrite(s, res) ==
    /\ BagIn(res, httpRes[s])
    /\ res.kind = "Write"
    /\ httpRes' = [httpRes EXCEPT ![s] = Remove(@, res)]
    /\ httpReq' = IF res.result = "Ok"
                  THEN [httpReq EXCEPT ![s] = Add(@, LoadReq(TokenOf(inFlight[s], gen[s]), "Refresh"))]
                  ELSE httpReq
    /\ UNCHANGED <<clock, ver, phase, wsq, loading, shown, inFlight, gen, sending,
                   changes, losses, disconnects, lastIssued>>

\* 読み込みの応答（use-session-timer.ts の load）。操作と重なった読み込みは、読み込めているなら捨てる
\* （operation-overlap.ts の overlapped）。失敗は、読み込めていなければ LoadFailed
ReceiveLoad(s, res) ==
    /\ BagIn(res, httpRes[s])
    /\ res.kind = "Load"
    /\ httpRes' = [httpRes EXCEPT ![s] = Remove(@, res)]
    /\ LET overlapped == /\ Mutation /= "NoOverlapCheck"
                         /\ (res.token.busy \/ res.token.gen /= gen[s])
       IN IF res.result = "Ok"
          THEN IF overlapped /\ loading[s] = "Loaded"
               THEN UNCHANGED <<loading, shown>>
               ELSE ApplyReceived(s, res.snap)
          ELSE /\ loading' = [loading EXCEPT ![s] = IF @ = "Loaded" THEN "Loaded" ELSE "LoadFailed"]
               /\ UNCHANGED shown
    /\ sending' = IF res.cause = "AfterSend" THEN [sending EXCEPT ![s] = "Idle"] ELSE sending
    /\ UNCHANGED <<clock, ver, phase, wsq, httpReq, inFlight, gen, changes, losses, disconnects, lastIssued>>

\* 繋ぎ直す（sync-connection.ts の scheduleReconnect のタイマー、または check）
Reconnect(s) ==
    /\ phase[s] = "Waiting"
    /\ phase' = [phase EXCEPT ![s] = "Connecting"]
    /\ UNCHANGED <<clock, ver, wsq, httpReq, httpRes, loading, shown, inFlight, gen, sending,
                   changes, losses, disconnects, lastIssued>>

-----------------------------------------------------------------------------
(* 通信の失敗                                                              *)

\* 要求が UserDO に届かない。画面には Unreachable が返る
FailOf(req) ==
    CASE req.kind = "Op" -> [kind |-> "Op", result |-> "Unreachable"]
      [] req.kind = "Write" -> [kind |-> "Write", result |-> "Unreachable"]
      [] req.kind = "Load" -> [kind |-> "Load", result |-> "Unreachable",
                                token |-> req.token, cause |-> req.cause]

LoseRequest(s, req) ==
    /\ losses < MaxLosses
    /\ BagIn(req, httpReq[s])
    /\ httpReq' = [httpReq EXCEPT ![s] = Remove(@, req)]
    /\ httpRes' = [httpRes EXCEPT ![s] = Add(@, FailOf(req))]
    /\ losses' = losses + 1
    /\ UNCHANGED <<clock, ver, phase, wsq, loading, shown, inFlight, gen, sending,
                   changes, disconnects, lastIssued>>

\* UserDO は処理したが、応答が画面に届かない。画面には Unreachable が返る
LoseResponse(s, res) ==
    /\ losses < MaxLosses
    /\ BagIn(res, httpRes[s])
    /\ res.result = "Ok"
    /\ httpRes' = [httpRes EXCEPT ![s] = Add(Remove(@, res),
                     CASE res.kind = "Op" -> [kind |-> "Op", result |-> "Unreachable"]
                       [] res.kind = "Write" -> [kind |-> "Write", result |-> "Unreachable"]
                       [] res.kind = "Load" -> [kind |-> "Load", result |-> "Unreachable",
                                                 token |-> res.token, cause |-> res.cause])]
    /\ losses' = losses + 1
    /\ UNCHANGED <<clock, ver, phase, wsq, httpReq, loading, shown, inFlight, gen, sending,
                   changes, disconnects, lastIssued>>

\* WebSocket が切れる（onClose、または pong が返らず捨てる）。届いていないメッセージは失われる
Disconnect(s) ==
    /\ disconnects < MaxDisconnects
    /\ phase[s] \in {"Connecting", "Accepted", "Open"}
    /\ phase' = [phase EXCEPT ![s] = "Waiting"]
    /\ wsq' = [wsq EXCEPT ![s] = <<>>]
    /\ disconnects' = disconnects + 1
    /\ UNCHANGED <<clock, ver, httpReq, httpRes, loading, shown, inFlight, gen, sending,
                   changes, losses, lastIssued>>

-----------------------------------------------------------------------------
Requests(s) == BagToSet(httpReq[s])
Responses(s) == BagToSet(httpRes[s])

System(s) ==
    \/ \E req \in Requests(s), ok \in BOOLEAN : ServeOp(s, req, ok)
    \/ \E req \in Requests(s) : ServeWrite(s, req)
    \/ \E req \in Requests(s) : ServeLoad(s, req)
    \/ Accept(s)
    \/ Opened(s)
    \/ ReceiveSync(s)
    \/ \E res \in Responses(s) : ReceiveOp(s, res) \/ ReceiveWrite(s, res) \/ ReceiveLoad(s, res)
    \/ Reconnect(s)
    \/ Reload(s)

Environment(s) ==
    \/ Operate(s)
    \/ Write(s)
    \/ \E req \in Requests(s) : LoseRequest(s, req)
    \/ \E res \in Responses(s) : LoseResponse(s, res)
    \/ Disconnect(s)

Next ==
    \/ Tick
    \/ \E s \in Screens : System(s) \/ Environment(s)

\* 書き込みと通信の失敗が尽きたあとは、UserDO と画面と繋ぎ直しは必ず進む。
\* 「読み込み直す」もいつかは押される
Fairness ==
    \A s \in Screens :
        /\ WF_vars(\E req \in Requests(s), ok \in BOOLEAN : ServeOp(s, req, ok))
        /\ WF_vars(\E req \in Requests(s) : ServeWrite(s, req))
        /\ WF_vars(\E req \in Requests(s) : ServeLoad(s, req))
        /\ WF_vars(Accept(s))
        /\ WF_vars(Opened(s))
        /\ WF_vars(ReceiveSync(s))
        /\ WF_vars(\E res \in Responses(s) :
                     (ReceiveOp(s, res) \/ ReceiveWrite(s, res) \/ ReceiveLoad(s, res)))
        /\ WF_vars(Reconnect(s))
        /\ WF_vars(Reload(s))

Spec == Init /\ [][Next]_vars /\ Fairness

\* 画面を入れ替えても同じ並び。安全性の検査でだけ使う（活性の検査で使うと見落とすことがある）
ScreenSymmetry == Permutations(Screens)

-----------------------------------------------------------------------------
(* 確かめる性質                                                            *)

TypeOK ==
    /\ \A s \in Screens : loading[s] \in {"Loading", "LoadFailed", "Loaded"}
    /\ \A s \in Screens : phase[s] \in {"Connecting", "Accepted", "Open", "Waiting"}
    /\ \A s \in Screens : sending[s] \in {"Idle", "Sending"}
    /\ \A s \in Screens : inFlight[s] \in {0, 1}

\* 一度読み込めた画面は読み込めたまま（Reload は LoadFailed からだけ）。下の2つを1歩ずつ比べてよい根拠
StaysLoaded ==
    [][\A s \in Screens : loading[s] = "Loaded" => loading'[s] = "Loaded"]_vars

\* 安全性1: どの画面も、一度見せたスナップショットよりサーバーの時刻が前のものに戻らない
NoTimeRollback ==
    [][\A s \in Screens : loading[s] = "Loaded" => shown'[s].t >= shown[s].t]_vars

\* 安全性1'（利用者から見た害）: どの画面も、一度見せた変更より前の記録に戻らない
NoChangeRollback ==
    [][\A s \in Screens : loading[s] = "Loaded" => shown'[s].v >= shown[s].v]_vars

\* 安全性2: 同じサーバーの時刻のスナップショットは同じ変更である（isOlder の前提）。
\* 時刻も変更の数も減らないので、続けて出した2つを比べれば足りる
SameTimeSameChange ==
    [][lastIssued'.t = lastIssued.t => lastIssued'.v = lastIssued.v]_vars

\* 活性: 変更が止まれば、すべての画面はいつか最新のスナップショットにそろう
Converged == \A s \in Screens : loading[s] = "Loaded" /\ shown[s].v = ver
EventuallyConverged == <>[]Converged
=============================================================================
