-------------------------- MODULE SessionSyncTrace --------------------------
(***************************************************************************)
(* 実装のトレースを SessionSync のアクションでたどれるかを確かめる。        *)
(*                                                                         *)
(* トレースは apps/web/src/testing/session-sync-trace.workers.test.ts が、  *)
(* 本物の UserDO と画面の反映（client/snapshot-arrival.ts、                *)
(* operation-overlap.ts）を動かして記録する。1手ごとに、そのアクションが   *)
(* モデルで起こせて、起こしたあとの値（UserDO が出したスナップショット、    *)
(* 画面が見せているスナップショット）が実装と同じであることを求める。     *)
(* 最後の手までたどれれば、そのトレースはモデルの振る舞いの1つ。           *)
(***************************************************************************)
EXTENDS SessionSync, SessionSyncTraceData

VARIABLE i

Snap(e) == [t |-> e.t, v |-> e.v]

\* 画面が見せているもの（読み込めていなければ shown は見ない）
Observed(e) ==
    /\ loading'[e.screen] = e.loading
    /\ e.loading = "Loaded" => shown'[e.screen] = [t |-> e.shownT, v |-> e.shownV]

Match(e) ==
    CASE e.action = "Operate" -> Operate(e.screen)
      [] e.action = "ServeOp" ->
            /\ \E req \in Requests(e.screen) : ServeOp(e.screen, req, e.result = "Ok")
            /\ e.result = "Ok" => lastIssued' = Snap(e)
      [] e.action = "ServeLoad" ->
            /\ \E req \in Requests(e.screen) : req.kind = "Load" /\ req.cause = e.cause /\ ServeLoad(e.screen, req)
            /\ lastIssued' = Snap(e)
      [] e.action = "Accept" -> Accept(e.screen)
      [] e.action = "Opened" -> Opened(e.screen)
      [] e.action = "ReceiveSync" -> ReceiveSync(e.screen) /\ Observed(e)
      [] e.action = "ReceiveOp" ->
            \E res \in Responses(e.screen) :
                /\ res.kind = "Op" /\ res.result = e.result
                /\ ReceiveOp(e.screen, res)
                /\ Observed(e)
      [] e.action = "ReceiveLoad" ->
            \E res \in Responses(e.screen) :
                /\ res.kind = "Load" /\ res.cause = e.cause
                /\ ReceiveLoad(e.screen, res)
                /\ Observed(e)
      [] e.action = "Disconnect" -> Disconnect(e.screen)
      [] e.action = "Reconnect" -> Reconnect(e.screen)

TraceInit == Init /\ i = 1

\* UserDO の時計は、次に処理する要求の時刻まで Tick で進める
TraceNext ==
    \/ /\ i <= Len(Trace)
       /\ Match(Trace[i])
       /\ i' = i + 1
    \/ /\ i <= Len(Trace)
       /\ Trace[i].action \in {"ServeOp", "ServeLoad"}
       /\ clock < Trace[i].t
       /\ Tick
       /\ UNCHANGED i

\* 最後の手までたどれると破れる。破れれば、トレースはモデルの振る舞い
TraceUnfinished == i <= Len(Trace)

\* Goal 手目までたどれると破れる。たどれないときに、どの手で行き詰まったかを探すのに使う
TraceBeforeGoal == i <= Goal
=============================================================================
