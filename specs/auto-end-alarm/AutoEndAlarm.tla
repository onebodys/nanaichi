---------------------------- MODULE AutoEndAlarm ----------------------------
(***************************************************************************)
(* UserDO の自動終了の alarm のモデル（Issue #35）。                       *)
(*                                                                         *)
(* 確かめること:                                                           *)
(*   - 閉じていないセッションは、要求が来なくなれば、いつか必ず閉じられる  *)
(*   - 自動終了の時刻（autoEndDueAt）より前には自動で閉じられない          *)
(*   - alarm をいまより前の時刻に張らない（同じ過去の時刻で鳴り続けない）  *)
(*                                                                         *)
(* 各アクションが写しているコードは、アクションの上のコメントに書く。      *)
(* ドメインの計算（Session.stateAt と autoEndDueAt）は「自動終了の時刻に   *)
(* なったら Ended」とだけ写す。これがコードで成り立つことは                *)
(* .agents/skills/session-history の網羅検査が確かめている。               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    RequestUntil,   \* 要求が来うる最後の時刻
    MaxDue,         \* 記入・操作が決める自動終了の時刻の上限
    MaxRequests,    \* 要求の数の上限
    MaxFailures,    \* alarm() が失敗する回数の上限（環境の仮定）
    AlarmRetries,   \* alarm() が失敗したとき Cloudflare が再試行する回数
    Bug             \* 壊したモデル。"None" が実装どおり（.agents/skills/auto-end-alarm の表）

Bugs == {"None", "RearmOnlyOnStart", "SplitCommit", "OffByOne", "CloseOnAlarm"}

ASSUME Bug \in Bugs

Ops == {"Start", "Activity", "End", "Read"}

NoSession == [kind |-> "None"]
OpenSession(due) == [kind |-> "Open", due |-> due]

NotScheduled == [kind |-> "NotScheduled"]
Scheduled(at) == [kind |-> "Scheduled", at |-> at]

Unset == [kind |-> "Unset"]
AlarmAt(at, retry) == [kind |-> "Set", at |-> at, retry |-> retry]

Idle == [kind |-> "Idle"]
Firing(retry) == [kind |-> "Firing", retry |-> retry]

NotClosed == [kind |-> "NotClosed"]
AutoClosed(due) == [kind |-> "AutoClosed", due |-> due]

VARIABLES
    now,        \* いまの時刻
    session,    \* 閉じていないセッション（findOpenSession が返すもの）
    alarm,      \* ctx.storage の alarm。1つの DO に1つだけ
    handler,    \* alarm が鳴ったあと、alarm() がまだ走っていなければ Firing
    unapplied,  \* SplitCommit のときだけ使う。トランザクションのあと、まだ setAlarm していない予定
    requests,   \* これまでの要求の数
    failures,   \* これまでに alarm() が失敗した数
    lastRun     \* 最後の #run が何をしたか（性質を状態として書くための記録）

vars == <<now, session, alarm, handler, unapplied, requests, failures, lastRun>>

(***************************************************************************)
(* ドメインの写し                                                          *)
(***************************************************************************)

\* Session.stateAt(session, t).kind = "Ended"。最後の記入・操作から2ラウンド分たてば Ended
\* （timer-state.ts の autoEndIfInactiveUntil の `>=`）。OffByOne はそれを `>` にしたもの
Ended(s, t) ==
    /\ s.kind = "Open"
    /\ IF Bug = "OffByOne" THEN t > s.due ELSE t >= s.due

\* loadOpenSession（auto-end-session.ts）。Ended なら閉じて「セッションなし」にする
LoadOpen(s, t) == IF Ended(s, t) THEN NoSession ELSE s

\* ワークフローが記録したあとのセッション。`due` は記入・操作のあとの Session.autoEndDueAt。
\* 開始（start-session.ts）は閉じていないセッションがあれば断る。記入・操作・進め方の変更
\* （write-journal-entry.ts、operate-session.ts、change-advance-mode.ts）は閉じていないセッションにだけ記録する。
\* End の操作はセッションを Ended にし、settleAutoEnd の loadOpenSession が閉じる
Apply(op, s, due) ==
    CASE op = "Start"    -> IF s.kind = "None" THEN OpenSession(due) ELSE s
      [] op = "Activity" -> IF s.kind = "Open" THEN OpenSession(due) ELSE s
      [] op = "End"      -> NoSession
      [] op = "Read"     -> s

\* settleAutoEnd（auto-end-session.ts）が返す予定
ScheduleOf(s) == IF s.kind = "Open" THEN Scheduled(s.due) ELSE NotScheduled

\* #applySchedule（user-do.ts）。setAlarm は前の alarm（再試行の待ちも含む）を置き換える
AlarmAfter(schedule) ==
    IF schedule.kind = "Scheduled" THEN AlarmAt(schedule.at, 0) ELSE Unset

(***************************************************************************)
(* #run（user-do.ts）                                                       *)
(*                                                                         *)
(* transactionSync の中でワークフローと settleAutoEnd を走らせ、同じ同期の *)
(* 処理のまま setAlarm / deleteAlarm を呼ぶ。そのあいだに await がないので *)
(* ほかの要求も alarm() も割り込めない。だから1つのアクションにする。      *)
(* SplitCommit は、間に await を入れて予定の反映が後回しになった実装。     *)
(***************************************************************************)
Run(op, due, isAlarm) ==
    LET loaded   == IF isAlarm /\ Bug = "CloseOnAlarm" THEN NoSession
                    ELSE LoadOpen(session, now)
        closed   == IF session.kind = "Open" /\ loaded.kind = "None"
                    THEN AutoClosed(session.due) ELSE NotClosed
        recorded == Apply(op, loaded, due)
        settled  == LoadOpen(recorded, now)
        schedule == ScheduleOf(settled)
        rearms   == Bug /= "RearmOnlyOnStart" \/ op = "Start"
    IN
    /\ session' = settled
    /\ lastRun' = [now |-> now, op |-> op, closed |-> closed, schedule |-> schedule]
    /\ IF Bug = "SplitCommit"
       THEN /\ unapplied' = unapplied \cup {[id |-> requests, schedule |-> schedule]}
            /\ UNCHANGED alarm
       ELSE /\ alarm' = IF rearms THEN AlarmAfter(schedule) ELSE alarm
            /\ UNCHANGED unapplied

\* 画面・MCP・ジャーナルからの完了などから来る要求。すべて #run を通る
Request(op, due) ==
    /\ Run(op, due, FALSE)
    /\ requests' = requests + 1
    /\ UNCHANGED <<now, handler, failures>>

\* alarm の時刻になり、Cloudflare が alarm() を呼ぶことにした。alarm() は1つずつしか走らない。
\* 呼ばれるまでのあいだに要求が割り込みうる（遅れて鳴る、または要求と競合する）として、
\* 鳴ることと alarm() が走ることを別のアクションにする
Fire ==
    /\ alarm.kind = "Set"
    /\ alarm.at <= now
    /\ handler.kind = "Idle"
    /\ handler' = Firing(alarm.retry)
    /\ alarm' = Unset
    /\ UNCHANGED <<now, session, unapplied, requests, failures, lastRun>>

\* alarm()（user-do.ts）。#run(() => undefined) を走らせる
AlarmSucceeds ==
    /\ handler.kind = "Firing"
    /\ Run("Read", 0, TRUE)
    /\ handler' = Idle
    /\ UNCHANGED <<now, requests, failures>>

\* alarm() が例外で終わった。transactionSync の書き込みは取り消され、setAlarm も呼ばれない。
\* Cloudflare は少し後に再試行し、AlarmRetries 回で諦める。
\* 鳴ってから走るまでに要求が alarm を張り直していれば、そちらが残る
AlarmFails ==
    /\ handler.kind = "Firing"
    /\ failures < MaxFailures
    /\ failures' = failures + 1
    /\ handler' = Idle
    /\ alarm' = IF alarm.kind = "Set" THEN alarm
                ELSE IF handler.retry < AlarmRetries
                     THEN AlarmAt(now + 1, handler.retry + 1)
                     ELSE Unset
    /\ UNCHANGED <<now, session, unapplied, requests, lastRun>>

\* SplitCommit のときだけ: 後回しにした setAlarm / deleteAlarm。どの順で反映されてもよい
ApplySchedule(u) ==
    /\ u \in unapplied
    /\ unapplied' = unapplied \ {u}
    /\ alarm' = AlarmAfter(u.schedule)
    /\ UNCHANGED <<now, session, handler, requests, failures, lastRun>>

\* 時間が進む。待つもの（これから来うる要求、未来の alarm）がなければ進めない。
\* 進めても何も起きないので、状態を有限にするため
Tick ==
    /\ \/ now < RequestUntil
       \/ alarm.kind = "Set" /\ alarm.at > now
    /\ now' = now + 1
    /\ UNCHANGED <<session, alarm, handler, unapplied, requests, failures, lastRun>>

Init ==
    /\ now = 0
    /\ session = NoSession
    /\ alarm = Unset
    /\ handler = Idle
    /\ unapplied = {}
    /\ requests = 0
    /\ failures = 0
    /\ lastRun = [now |-> 0, op |-> "Read", closed |-> NotClosed, schedule |-> NotScheduled]

\* 記入・操作のあとの自動終了の時刻は、その時刻より後（最後の記入・操作から2ラウンド分）
NextRequest ==
    /\ now <= RequestUntil
    /\ requests < MaxRequests
    /\ \E op \in Ops, due \in (now + 1)..MaxDue : Request(op, due)

Next ==
    \/ NextRequest
    \/ Fire
    \/ AlarmSucceeds
    \/ AlarmFails
    \/ \E u \in unapplied : ApplySchedule(u)
    \/ Tick

\* 要求は来なくなってよい（公平性なし）。時間・alarm・alarm() の実行・後回しの setAlarm は止まらない
Fairness ==
    /\ WF_vars(Tick)
    /\ WF_vars(Fire)
    /\ WF_vars(AlarmSucceeds \/ AlarmFails)
    /\ WF_vars(\E u \in unapplied : ApplySchedule(u))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* 性質                                                                    *)
(***************************************************************************)

TypeOK ==
    /\ now \in Nat
    /\ session.kind \in {"None", "Open"}
    /\ alarm.kind \in {"Unset", "Set"}
    /\ handler.kind \in {"Idle", "Firing"}
    /\ requests \in 0..MaxRequests
    /\ failures \in 0..MaxFailures

\* 安全性: 自動で閉じるのは、自動終了の時刻を過ぎてから
NotClosedBeforeDue ==
    lastRun.closed.kind = "AutoClosed" => lastRun.now >= lastRun.closed.due

\* 安全性: alarm を張るなら、いまより後の時刻に張る。
\* いま以前に張ると、すぐ鳴り、また同じ時刻に張り直して鳴り続ける
ScheduledInFuture ==
    lastRun.schedule.kind = "Scheduled" => lastRun.schedule.at > lastRun.now

\* 活性のための不変条件: 閉じていないセッションには、張った alarm か、走る前の alarm() か、
\* まだ反映していない予定がある。どれもなければ、誰も閉じに来ない
OpenSessionIsWatched ==
    session.kind = "Open" =>
        \/ alarm.kind = "Set"
        \/ handler.kind = "Firing"
        \/ unapplied /= {}

\* 活性: 閉じていないセッションは、いつか必ず閉じられる（要求が来なくなっても）
EventuallyClosed == session.kind = "Open" ~> session.kind = "None"

=============================================================================
