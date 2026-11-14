------------------------- MODULE TraceAutoEndAlarm -------------------------
(***************************************************************************)
(* 実装のトレースを AutoEndAlarm に通す（Issue #35）。                     *)
(*                                                                         *)
(* トレースは auto-end-trace.workers.test.ts が本物の UserDO で記録し、    *)
(* check.mjs が TraceData.tla の Trace に変える。1歩ごとに、モデルの同じ   *)
(* アクションを動かし、そのあとの閉じていないセッション・alarm・自動終了   *)
(* した数が実装と一致するかを見る。                                        *)
(*                                                                         *)
(* 一致しない歩があると、次の状態がなくなり TLC が deadlock として落ちる。 *)
(* 最後まで一致すれば Done で止まり、エラーなしで終わる。                  *)
(***************************************************************************)
EXTENDS AutoEndAlarm, Sequences, TraceData

VARIABLES
    i,          \* 一致したトレースの歩の数
    autoEnded   \* モデルで自動終了したセッションの数

traceVars == <<vars, i, autoEnded>>

Event == Trace[i + 1]

\* トレースの alarm（張られていなければ "Unset"）と、モデルの alarm が一致する
AlarmMatches(observed, modeled) ==
    IF observed.kind = "Unset" THEN modeled.kind = "Unset"
    ELSE modeled.kind = "Set" /\ modeled.at = observed.at

\* 実装が記録した自動終了の時刻。閉じていないセッションがあれば alarm はその時刻にある
DueOf(e) == IF e.alarm.kind = "Set" THEN e.alarm.at ELSE now + 1

TraceInit ==
    /\ Init
    /\ i = 0
    /\ autoEnded = 0

\* トレースの次の歩の時刻まで時間を進める
Elapse ==
    /\ i < Len(Trace)
    /\ now < Event.now
    /\ now' = Event.now
    /\ UNCHANGED <<session, alarm, handler, unapplied, requests, failures, lastRun, i, autoEnded>>

\* runDurableObjectAlarm が alarm() を呼ぶ前に、alarm が鳴る
FireBeforeAlarm ==
    /\ i < Len(Trace)
    /\ now = Event.now
    /\ Event.kind = "Alarm"
    /\ Fire
    /\ UNCHANGED <<i, autoEnded>>

Replay ==
    /\ i < Len(Trace)
    /\ now = Event.now
    /\ IF Event.kind = "Request"
       THEN /\ handler.kind = "Idle"
            /\ DueOf(Event) > now
            /\ Request(Event.op, DueOf(Event))
       ELSE AlarmSucceeds
    /\ i' = i + 1
    /\ autoEnded' = autoEnded + (IF lastRun'.closed.kind = "AutoClosed" THEN 1 ELSE 0)
    /\ (session'.kind = "Open") = Event.open
    /\ AlarmMatches(Event.alarm, alarm')
    /\ autoEnded' = Event.autoEnded

Done ==
    /\ i = Len(Trace)
    /\ UNCHANGED traceVars

TraceNext == Elapse \/ FireBeforeAlarm \/ Replay \/ Done

TraceSpec == TraceInit /\ [][TraceNext]_traceVars

=============================================================================
