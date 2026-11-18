---------------------------- MODULE SessionSync ----------------------------
(***************************************************************************)
(* 画面のセッションの同期（ADR 0012）のモデル。                            *)
(*                                                                         *)
(* UserDO（apps/web/src/server/user-do.ts）が記録を変えるたびに、HTTP の   *)
(* 応答と WebSocket の同期メッセージ（SessionChanged）の両方でスナップショット*)
(* が届く。届く順は入れ替わりうる。画面（client/use-session-timer.ts と    *)
(* client/snapshot-arrival.ts）は SessionSnapshot.isOlder                 *)
(* （domain/session.ts）で変更の番号が古いものを捨てる（ADR 0030）。       *)
(*                                                                         *)
(* スナップショットは [t |-> サーバーの時刻, v |-> 何番目の変更までを含むか,*)
(* r |-> 変更の番号] で表す。v は実装にはない、検査のための値（同じ v なら  *)
(* 同じ記録）。r は実装の revision で、壊した実装でなければ v と同じ。      *)
(* 時刻と変更の番号は、実装の値そのものではなく、大小の順だけを残した      *)
(* 小さな整数。                                                            *)
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
    Mutations,     \* 検査が落ちることを確かめるための、わざと壊した実装の集合（{} なら壊さない）
    Fixes          \* 見つかった問題の直し方の候補の集合。実装にはまだない（{} なら実装のとおり）

ASSUME Mutations \subseteq {"IsOlderReversed", "IsOlderByTime", "NoRefreshOnConnect",
                            "WriteKeepsRevision"}
\* HoldSyncWhileLoading: 読み込めていない間に届いた同期メッセージを捨てず、読み込めてから反映する
ASSUME Fixes \subseteq {"HoldSyncWhileLoading"}

NoSnap == [t |-> 0, v |-> 0, r |-> 0]   \* まだ何も受け取っていない画面の shown（Loaded でなければ読まない）

\* domain/session.ts の SessionSnapshot.isOlder。変更の番号で比べ、同じ番号ならサーバーの時刻で比べる。
\* IsOlderByTime は #51 を直す前の実装（サーバーの時刻だけで比べる）
IsOlder(received, current) ==
    CASE "IsOlderReversed" \in Mutations ->
            \/ received.r > current.r
            \/ received.r = current.r /\ received.t > current.t
      [] "IsOlderByTime" \in Mutations -> received.t < current.t
      [] OTHER ->
            \/ received.r < current.r
            \/ received.r = current.r /\ received.t < current.t

VARIABLES
    clock,      \* UserDO の new Date()（user-do.ts の #run）
    ver,        \* UserDO の記録が何回変わったか
    rev,        \* UserDO の変更の番号（user-do-schema.ts の record_revision。行を変えるたびにトリガーが進める）
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
    sending,    \* use-session-timer.ts の send の途中か（pending）。"Idle" / "Sending"
    changes,    \* これまでに送った書き込みの数（上限のため）
    losses,     \* これまでに HTTP の要求・応答が失われた数（上限のため）
    disconnects,\* これまでに WebSocket が切れた数（上限のため）
    lastIssued  \* 検査用: UserDO が最後に出したスナップショット

vars == <<clock, ver, rev, phase, wsq, httpReq, httpRes, loading, shown,
          sending, changes, losses, disconnects, lastIssued>>

Bag1(x) == SetToBag({x})
Add(b, x) == b (+) Bag1(x)
Remove(b, x) == b (-) Bag1(x)

\* 要求を送った時刻。ClockStalls = TRUE のとき、要求は送った時刻より後（1ms 以上あと）に処理される。
\* ClockStalls = FALSE なら使わない（状態を増やさないよう 0 にする）
SentAt == IF ClockStalls THEN clock ELSE 0

OpReq == [kind |-> "Op", sentAt |-> SentAt]
WriteReq == [kind |-> "Write", sentAt |-> SentAt]
LoadReq(cause) == [kind |-> "Load", cause |-> cause, sentAt |-> SentAt]

-----------------------------------------------------------------------------
Init ==
    /\ clock = 1
    /\ ver = 0
    /\ rev = 0
    \* 画面を開くと同期の WebSocket を開き（use-sync.ts）、読み込みを始める（use-session-timer.ts の useEffect）
    /\ phase = [s \in Screens |-> "Connecting"]
    /\ wsq = [s \in Screens |-> <<>>]
    /\ httpReq = [s \in Screens |->
                    Bag1([kind |-> "Load", cause |-> "Refresh", sentAt |-> 0])]
    /\ httpRes = [s \in Screens |-> EmptyBag]
    /\ loading = [s \in Screens |-> "Loading"]
    /\ shown = [s \in Screens |-> NoSnap]
    /\ sending = [s \in Screens |-> "Idle"]
    /\ changes = 0
    /\ losses = 0
    /\ disconnects = 0
    /\ lastIssued = NoSnap

\* use-session-timer.ts の applyReceived（snapshot-arrival.ts）。操作の応答も読み込みの応答も、
\* 同期メッセージも、変更の番号で比べる（Issue #54 で、操作と重なった読み込みを捨てるのをやめた）
ApplyReceived(s, snap) ==
    IF loading[s] = "Loaded" /\ IsOlder(snap, shown[s])
    THEN UNCHANGED <<loading, shown>>
    ELSE /\ loading' = [loading EXCEPT ![s] = "Loaded"]
         /\ shown' = [shown EXCEPT ![s] = snap]

-----------------------------------------------------------------------------
(* 画面の操作                                                              *)

\* 開始・操作のボタン（use-session-timer.ts の start / operate → send）。
\* 送っている途中はボタンを押せない（pending）
Operate(s) ==
    /\ loading[s] = "Loaded"
    /\ sending[s] = "Idle"
    /\ changes < MaxChanges
    /\ sending' = [sending EXCEPT ![s] = "Sending"]
    /\ httpReq' = [httpReq EXCEPT ![s] = Add(@, OpReq)]
    /\ changes' = changes + 1
    /\ UNCHANGED <<clock, ver, rev, phase, wsq, httpRes, loading, shown, losses, disconnects, lastIssued>>

\* ジャーナル記入や進め方の変更（timeline / advance-mode の API）。応答はスナップショットではなく、
\* 成功したら timer.refresh() で読み込み直す（home-page.tsx）
Write(s) ==
    /\ WithWrites
    /\ loading[s] = "Loaded"
    /\ changes < MaxChanges
    /\ httpReq' = [httpReq EXCEPT ![s] = Add(@, WriteReq)]
    /\ changes' = changes + 1
    /\ UNCHANGED <<clock, ver, rev, phase, wsq, httpRes, loading, shown, sending,
                   losses, disconnects, lastIssued>>

\* 「読み込み直す」ボタン（timer-panel.tsx。LoadFailed のときだけ出る）
Reload(s) ==
    /\ loading[s] = "LoadFailed"
    /\ loading' = [loading EXCEPT ![s] = "Loading"]
    /\ httpReq' = [httpReq EXCEPT ![s] = Add(@, LoadReq("Refresh"))]
    /\ UNCHANGED <<clock, ver, rev, phase, wsq, httpRes, shown, sending,
                   changes, losses, disconnects, lastIssued>>

-----------------------------------------------------------------------------
(* UserDO。要求は1つずつ処理する（Durable Object は要求を直列にする）       *)

\* 時計が進む。ClockStalls = FALSE のときは Serve が進めるので、Tick は使わない
Tick ==
    /\ ClockStalls
    /\ clock < MaxClock
    /\ clock' = clock + 1
    /\ UNCHANGED <<ver, rev, phase, wsq, httpReq, httpRes, loading, shown, sending,
                   changes, losses, disconnects, lastIssued>>

\* 今の時刻で req を処理してよいか。送ってから UserDO に届くまでに 1ms 以上かかる
CanServeNow(req) == ~ClockStalls \/ clock > req.sentAt

\* 要求を処理したあとの時計
ClockAfterServe ==
    IF ClockStalls
    THEN clock' = clock
    ELSE clock' = clock + 1

\* user-do.ts の #broadcast。受け入れた接続（getWebSockets）すべてへ送る
Broadcast(snap) ==
    wsq' = [s \in Screens |->
              IF phase[s] \in {"Accepted", "Open"} THEN Append(wsq[s], snap) ELSE wsq[s]]

\* POST /api/session, POST /api/session/commands（startSession / operateSession → #execute）
\* 受け付けられれば記録を変え、同期メッセージを送ってから応答を返す。
\* 断られる（409 など）ときは何も変えない
ServeOp(s, req, ok) ==
    LET snap == [t |-> clock, v |-> ver + 1, r |-> rev + 1]
    IN
    /\ BagIn(req, httpReq[s])
    /\ req.kind = "Op"
    /\ CanServeNow(req)
    /\ httpReq' = [httpReq EXCEPT ![s] = Remove(@, req)]
    /\ IF ok
       THEN /\ ver' = ver + 1
            /\ rev' = rev + 1
            /\ Broadcast(snap)
            /\ lastIssued' = snap
            /\ httpRes' = [httpRes EXCEPT ![s] = Add(@, [kind |-> "Op", result |-> "Ok", snap |-> snap])]
            /\ ClockAfterServe
       ELSE /\ httpRes' = [httpRes EXCEPT ![s] = Add(@, [kind |-> "Op", result |-> "Rejected"])]
            /\ ClockAfterServe
            /\ UNCHANGED <<ver, rev, wsq, lastIssued>>
    /\ UNCHANGED <<phase, loading, shown, sending, changes, losses, disconnects>>

\* POST /api/journal-entries など。記録を変え、SessionChanged を送る（workflows/user-commands.ts）。
\* WriteKeepsRevision は、記入などの書き込みで変更の番号を進め忘れた実装（トリガーのない表に書く）
ServeWrite(s, req) ==
    LET nextRev == IF "WriteKeepsRevision" \in Mutations THEN rev ELSE rev + 1
        snap == [t |-> clock, v |-> ver + 1, r |-> nextRev]
    IN
    /\ BagIn(req, httpReq[s])
    /\ req.kind = "Write"
    /\ CanServeNow(req)
    /\ httpReq' = [httpReq EXCEPT ![s] = Remove(@, req)]
    /\ ver' = ver + 1
    /\ rev' = nextRev
    /\ Broadcast(snap)
    /\ lastIssued' = snap
    /\ httpRes' = [httpRes EXCEPT ![s] = Add(@, [kind |-> "Write", result |-> "Ok"])]
    /\ ClockAfterServe
    /\ UNCHANGED <<phase, loading, shown, sending, changes, losses, disconnects>>

\* GET /api/session/current（getCurrentSession → #run）
ServeLoad(s, req) ==
    LET snap == [t |-> clock, v |-> ver, r |-> rev]
    IN
    /\ BagIn(req, httpReq[s])
    /\ req.kind = "Load"
    /\ CanServeNow(req)
    /\ httpReq' = [httpReq EXCEPT ![s] = Remove(@, req)]
    /\ lastIssued' = snap
    /\ httpRes' = [httpRes EXCEPT ![s] =
                     Add(@, [kind |-> "Load", result |-> "Ok", snap |-> snap,
                             cause |-> req.cause])]
    /\ ClockAfterServe
    /\ UNCHANGED <<ver, rev, phase, wsq, loading, shown, sending, changes, losses, disconnects>>

\* GET /api/ws（user-do.ts の fetch → acceptWebSocket）。これより後の同期メッセージがこの接続に届く
Accept(s) ==
    /\ phase[s] = "Connecting"
    /\ phase' = [phase EXCEPT ![s] = "Accepted"]
    /\ wsq' = [wsq EXCEPT ![s] = <<>>]
    /\ UNCHANGED <<clock, ver, rev, httpReq, httpRes, loading, shown, sending,
                   changes, losses, disconnects, lastIssued>>

-----------------------------------------------------------------------------
(* 画面が受け取る                                                          *)

\* sync-connection.ts の onOpen → use-sync.ts の onConnected → timer.refresh()
Opened(s) ==
    /\ phase[s] = "Accepted"
    /\ phase' = [phase EXCEPT ![s] = "Open"]
    /\ httpReq' = IF "NoRefreshOnConnect" \in Mutations
                  THEN httpReq
                  ELSE [httpReq EXCEPT ![s] = Add(@, LoadReq("Refresh"))]
    /\ UNCHANGED <<clock, ver, rev, wsq, httpRes, loading, shown, sending,
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
    /\ UNCHANGED <<clock, ver, rev, phase, httpReq, httpRes, sending, changes,
                   losses, disconnects, lastIssued>>

\* 開始・操作の応答（use-session-timer.ts の send）。
\* 成功なら反映し、断られたら読み込み直し（load）、届かなければ（Unreachable）何もしない
ReceiveOp(s, res) ==
    /\ BagIn(res, httpRes[s])
    /\ res.kind = "Op"
    /\ httpRes' = [httpRes EXCEPT ![s] = Remove(@, res)]
    /\ CASE res.result = "Ok" ->
              /\ ApplyReceived(s, res.snap)
              /\ sending' = [sending EXCEPT ![s] = "Idle"]
              /\ UNCHANGED httpReq
         [] res.result = "Rejected" ->
              \* pending は読み込みが終わるまで続く（await load()）
              /\ httpReq' = [httpReq EXCEPT ![s] =
                               Add(@, LoadReq("AfterSend"))]
              /\ UNCHANGED <<loading, shown, sending>>
         [] res.result = "Unreachable" ->
              /\ sending' = [sending EXCEPT ![s] = "Idle"]
              /\ UNCHANGED <<httpReq, loading, shown>>
    /\ UNCHANGED <<clock, ver, rev, phase, wsq, changes, losses, disconnects, lastIssued>>

\* 記入などの応答。成功したら timer.refresh()
ReceiveWrite(s, res) ==
    /\ BagIn(res, httpRes[s])
    /\ res.kind = "Write"
    /\ httpRes' = [httpRes EXCEPT ![s] = Remove(@, res)]
    /\ httpReq' = IF res.result = "Ok"
                  THEN [httpReq EXCEPT ![s] = Add(@, LoadReq("Refresh"))]
                  ELSE httpReq
    /\ UNCHANGED <<clock, ver, rev, phase, wsq, loading, shown, sending,
                   changes, losses, disconnects, lastIssued>>

\* 読み込みの応答（use-session-timer.ts の load）。自分の操作と重なった読み込みも、変更の番号で比べて
\* 反映する（Issue #54）。失敗は、読み込めていなければ LoadFailed
ReceiveLoad(s, res) ==
    /\ BagIn(res, httpRes[s])
    /\ res.kind = "Load"
    /\ httpRes' = [httpRes EXCEPT ![s] = Remove(@, res)]
    /\ IF res.result = "Ok"
       THEN ApplyReceived(s, res.snap)
       ELSE /\ loading' = [loading EXCEPT ![s] = IF @ = "Loaded" THEN "Loaded" ELSE "LoadFailed"]
            /\ UNCHANGED shown
    /\ sending' = IF res.cause = "AfterSend" THEN [sending EXCEPT ![s] = "Idle"] ELSE sending
    /\ UNCHANGED <<clock, ver, rev, phase, wsq, httpReq, changes, losses, disconnects, lastIssued>>

\* 繋ぎ直す（sync-connection.ts の scheduleReconnect のタイマー、または check）
Reconnect(s) ==
    /\ phase[s] = "Waiting"
    /\ phase' = [phase EXCEPT ![s] = "Connecting"]
    /\ UNCHANGED <<clock, ver, rev, wsq, httpReq, httpRes, loading, shown, sending,
                   changes, losses, disconnects, lastIssued>>

-----------------------------------------------------------------------------
(* 通信の失敗                                                              *)

\* 要求が UserDO に届かない。画面には Unreachable が返る
FailOf(req) ==
    CASE req.kind = "Op" -> [kind |-> "Op", result |-> "Unreachable"]
      [] req.kind = "Write" -> [kind |-> "Write", result |-> "Unreachable"]
      [] req.kind = "Load" -> [kind |-> "Load", result |-> "Unreachable",
                                cause |-> req.cause]

LoseRequest(s, req) ==
    /\ losses < MaxLosses
    /\ BagIn(req, httpReq[s])
    /\ httpReq' = [httpReq EXCEPT ![s] = Remove(@, req)]
    /\ httpRes' = [httpRes EXCEPT ![s] = Add(@, FailOf(req))]
    /\ losses' = losses + 1
    /\ UNCHANGED <<clock, ver, rev, phase, wsq, loading, shown, sending,
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
                                                 cause |-> res.cause])]
    /\ losses' = losses + 1
    /\ UNCHANGED <<clock, ver, rev, phase, wsq, httpReq, loading, shown, sending,
                   changes, disconnects, lastIssued>>

\* WebSocket が切れる（onClose、または pong が返らず捨てる）。届いていないメッセージは失われる
Disconnect(s) ==
    /\ disconnects < MaxDisconnects
    /\ phase[s] \in {"Connecting", "Accepted", "Open"}
    /\ phase' = [phase EXCEPT ![s] = "Waiting"]
    /\ wsq' = [wsq EXCEPT ![s] = <<>>]
    /\ disconnects' = disconnects + 1
    /\ UNCHANGED <<clock, ver, rev, httpReq, httpRes, loading, shown, sending,
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

\* 一度読み込めた画面は読み込めたまま（Reload は LoadFailed からだけ）。下の2つを1歩ずつ比べてよい根拠
StaysLoaded ==
    [][\A s \in Screens : loading[s] = "Loaded" => loading'[s] = "Loaded"]_vars

\* 安全性1: どの画面も、一度見せたスナップショットよりサーバーの時刻が前のものに戻らない
NoTimeRollback ==
    [][\A s \in Screens : loading[s] = "Loaded" => shown'[s].t >= shown[s].t]_vars

\* 安全性1'（利用者から見た害）: どの画面も、一度見せた変更より前の記録に戻らない
NoChangeRollback ==
    [][\A s \in Screens : loading[s] = "Loaded" => shown'[s].v >= shown[s].v]_vars

\* 安全性2: 同じ変更の番号のスナップショットは同じ変更である（isOlder の前提、ADR 0030）。
\* 変更の番号も変更の数も減らないので、続けて出した2つを比べれば足りる
SameRevisionSameChange ==
    [][lastIssued'.r = lastIssued.r => lastIssued'.v = lastIssued.v]_vars

\* 同じサーバーの時刻のスナップショットは同じ変更である。#51 を直す前の isOlder の前提だったもの。
\* 時計が止まると破れる（stall-same-time）。新旧をサーバーの時刻ではなく変更の番号で決める理由
SameTimeSameChange ==
    [][lastIssued'.t = lastIssued.t => lastIssued'.v = lastIssued.v]_vars

\* 活性: 変更が止まれば、すべての画面はいつか最新のスナップショットにそろう
Converged == \A s \in Screens : loading[s] = "Loaded" /\ shown[s].v = ver
EventuallyConverged == <>[]Converged
=============================================================================
