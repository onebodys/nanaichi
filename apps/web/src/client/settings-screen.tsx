import { useState, type ReactNode } from "react";
import { Result } from "@praha/byethrow";
import { PlayIcon } from "lucide-react";
import * as v from "valibot";
import {
  ALERT_TONES,
  toneFor,
  useAlertSettings,
  VOLUMES,
  withTone,
  type AlertTone,
} from "./alert-settings.ts";
import { AdvanceMode } from "../domain/advance-mode.ts";
import { TagName, type TagDeletion, type TagUsage } from "../domain/tag.ts";
import { signOut } from "./auth-client.ts";
import { Button, LinkButton } from "./components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog.tsx";
import { Import } from "../domain/import.ts";
import type { ClosedSession } from "../domain/session-record.ts";
import { ReadOnlyEntry } from "./entry-parts.tsx";
import {
  deviceRecordsLabelOf,
  deviceSessionLabelOf,
  deviceUnreadableMessageOf,
  importProgressLabelOf,
  lastImportLinesOf,
} from "./import-text.ts";
import { useImports } from "./use-import.ts";
import { deviceTimeZone } from "./use-stats.ts";
import { useRecordStore } from "./record-store.ts";
import {
  notificationPermission,
  requestNotificationPermission,
  type PhaseAlert,
} from "./phase-alert.ts";
import {
  advanceChoiceLabelOf,
  entryCountLabelOf,
  permissionNoteOf,
  tagDeletionActionOf,
  tagKindsNoteOf,
  tagLabelOf,
  themeLabelOf,
  TONE_TARGETS,
  toneLabelOf,
  toneTargetOf,
  transitionLabelOf,
  volumeLabelOf,
} from "./settings-text.ts";
import { OverlayScreen } from "./overlay-screen.tsx";
import { Segmented } from "./segmented.tsx";
import { modifierLabelOf, SubmitKeySchema, submitKeyLabelOf } from "./submit-key.ts";
import { THEME_PREFERENCES, useThemePreference } from "./theme.ts";
import type { TaskSettingState } from "./use-task-setting.ts";
import type { AdvanceModeState } from "./use-advance-mode.ts";
import { useSubmitKey } from "./use-submit-key.ts";
import type { TimerView } from "./use-session-timer.ts";
import type { TagUsageState } from "./use-tag-usage.ts";

const modifierLabel = modifierLabelOf(navigator.userAgent);

const AlertToneSchema = v.picklist(ALERT_TONES);

const toneItems = ALERT_TONES.map((tone) => ({ value: tone, label: toneLabelOf(tone) }));

/** 設定のまとまり。端末ごとの設定には「この端末」の印をつける（サーバーには送らず、他の端末には効かない） */
const Section = ({
  id,
  title,
  perDevice,
  children,
}: Readonly<{ id: string; title: string; perDevice: boolean; children: ReactNode }>) => (
  <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-20 flex-col gap-2.5">
    <div className="flex items-center gap-2.5">
      <h2 id={`${id}-title`} className="text-base font-semibold">
        {title}
      </h2>
      {perDevice && (
        <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          この端末
        </span>
      )}
    </div>
    <div className="flex flex-col divide-y rounded-[14px] border bg-card">{children}</div>
  </section>
);

const Row = ({
  label,
  description,
  children,
}: Readonly<{ label: string; description?: string | undefined; children?: ReactNode }>) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
    <div className="flex flex-col gap-0.5">
      <span className="text-[15px] font-medium">{label}</span>
      {description !== undefined && (
        <span className="text-xs text-muted-foreground">{description}</span>
      )}
    </div>
    {children}
  </div>
);

const ADVANCE_CHOICES = ["Auto", "Manual"] as const;

/**
 * フェーズの進め方（GLOSSARY、ADR 0016）。4つの切り替わりごとに自動か手動か。
 * 変えるとセッションの途中でもすぐ効く
 */
const AdvanceSection = ({ advanceMode }: Readonly<{ advanceMode: AdvanceModeState }>) => {
  const { view, errorMessage, change } = advanceMode;
  const recordStore = useRecordStore();
  return (
    <Section id="settings-advance" title="フェーズの進め方" perDevice={false}>
      <p className="px-5 py-3.5 text-xs leading-relaxed text-muted-foreground">
        手動にした切り替わりでは、時間が来ると 0:00 で止まって音で知らせ、ボタンを押すまで待ちます。
        {recordStore.kind === "Device"
          ? "この端末の設定です。"
          : "どの端末でも同じ設定になります。"}
      </p>
      {view.kind === "Loaded" ? (
        AdvanceMode.transitions.map((transition) => {
          const { label, description } = transitionLabelOf(transition);
          return (
            <Row key={transition} label={label} description={description}>
              <Segmented
                name={`advance-${transition}`}
                legend={`${label}の進め方`}
                options={ADVANCE_CHOICES.map((choice) => ({
                  value: choice,
                  label: advanceChoiceLabelOf(choice),
                }))}
                value={view.mode[transition]}
                onChange={(choice) => change({ ...view.mode, [transition]: choice })}
              />
            </Row>
          );
        })
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {view.kind === "Loading" ? "読み込み中…" : "読み込めませんでした"}
        </p>
      )}
      {errorMessage !== undefined && (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {errorMessage}
        </p>
      )}
    </Section>
  );
};

/**
 * ToDo の設定（GLOSSARY の「ToDo の設定」、ADR 0027）。アカウントの記録先でだけ出す。
 * この端末の記録先では ToDo 自体を使えないので、項目を出さない
 */
const TaskSection = ({ taskSetting }: Readonly<{ taskSetting: TaskSettingState }>) => {
  const { view, errorMessage, change } = taskSetting;
  return (
    <Section id="settings-tasks" title="ToDo" perDevice={false}>
      <p className="px-5 py-3.5 text-xs leading-relaxed text-muted-foreground">
        オンにすると、「〜が完了した」とジャーナルに書いたとき、合うタスクを自動で完了にします。どの端末でも同じ設定になります。
      </p>
      {view.kind === "Loaded" ? (
        <Row label="ToDo を使う" description="ホームにタスクの一覧を出します">
          <Switch
            aria-label="ToDo を使う"
            checked={view.setting.kind === "Enabled"}
            onCheckedChange={(on) => change({ kind: on ? "Enabled" : "Disabled" })}
          />
        </Row>
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {view.kind === "LoadFailed" ? "読み込めませんでした" : "読み込み中…"}
        </p>
      )}
      {errorMessage !== undefined && (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {errorMessage}
        </p>
      )}
    </Section>
  );
};

/** 知らせ方の設定（GLOSSARY）。音で知らせるか・音量・フェーズごとの音色・ブラウザ通知 */
const AlertSection = ({ phaseAlert }: Readonly<{ phaseAlert: PhaseAlert }>) => {
  const { settings, change } = useAlertSettings();
  const [permission, setPermission] = useState(notificationPermission);

  const setNotification = async (on: boolean) => {
    change({ ...settings, notification: on });
    if (on) {
      setPermission(await requestNotificationPermission());
    }
  };

  return (
    <Section id="settings-alert" title="知らせ方" perDevice>
      <Row label="音で知らせる" description="フェーズが切り替わったときに鳴らします">
        <Switch
          aria-label="音で知らせる"
          checked={settings.sound}
          onCheckedChange={(on) => change({ ...settings, sound: on })}
        />
      </Row>
      <Row label="音量">
        <Segmented
          name="alert-volume"
          legend="音量"
          disabled={!settings.sound}
          options={VOLUMES.map((volume) => ({ value: volume, label: volumeLabelOf(volume) }))}
          value={settings.volume}
          onChange={(volume) => {
            change({ ...settings, volume });
            // 選んだ音量をすぐ聞けるようにする
            phaseAlert.preview({ to: "Journal", tone: toneFor(settings, "Journal"), volume });
          }}
        />
      </Row>
      {TONE_TARGETS.map((to) => {
        const { label, description } = toneTargetOf(to);
        const tone = toneFor(settings, to);
        const play = (next: AlertTone) =>
          phaseAlert.preview({ to, tone: next, volume: settings.volume });
        return (
          <Row key={to} label={label} description={description}>
            <div className="flex items-center gap-2">
              <Select
                value={tone}
                items={toneItems}
                disabled={!settings.sound}
                onValueChange={(value) => {
                  const parsed = v.safeParse(AlertToneSchema, value);
                  if (parsed.success) {
                    change(withTone(settings, to, parsed.output));
                    // 選んだ音色をすぐ聞けるようにする
                    play(parsed.output);
                  }
                }}
              >
                <SelectTrigger aria-label={`${label}の音色`} className="min-w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {toneItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="secondary"
                aria-label={`${label}の音を試す`}
                disabled={!settings.sound}
                onClick={() => play(tone)}
              >
                <PlayIcon />
                試す
              </Button>
            </div>
          </Row>
        );
      })}
      <Row
        label="ブラウザ通知"
        description={settings.notification ? permissionNoteOf(permission) : undefined}
      >
        <Switch
          aria-label="ブラウザ通知"
          checked={settings.notification}
          onCheckedChange={(on) => void setNotification(on)}
        />
      </Row>
    </Section>
  );
};

const LookSection = () => {
  const [theme, setTheme] = useThemePreference();
  return (
    <Section id="settings-look" title="表示" perDevice>
      <Row label="テーマ">
        <Segmented
          name="theme"
          legend="テーマ"
          options={THEME_PREFERENCES.map((preference) => ({
            value: preference,
            label: themeLabelOf(preference),
          }))}
          value={theme}
          onChange={setTheme}
        />
      </Row>
    </Section>
  );
};

const WriteSection = () => {
  const [submitKey, setSubmitKey] = useSubmitKey();
  return (
    <Section id="settings-write" title="記入" perDevice>
      <Row label="送信キー" description="入力欄の隣でも切り替えられます">
        <Segmented
          name="submit-key"
          legend="送信キー"
          options={SubmitKeySchema.options.map((option) => ({
            value: option,
            label: submitKeyLabelOf(option, modifierLabel),
          }))}
          value={submitKey}
          onChange={setSubmitKey}
        />
      </Row>
    </Section>
  );
};

const DELETION_CHOICES = ["Detach", "Reassign"] as const;

/**
 * 1つのタグを削除する前に、ついている記入のタグを外すか付け替えるかを選ぶ（GLOSSARY の「タグの削除」）。
 * 付け替え先は使っている他のタグ `others` から選ぶ
 */
const TagDeletionForm = ({
  usage,
  others,
  remove,
  cancel,
}: Readonly<{
  usage: TagUsage;
  others: ReadonlyArray<TagName>;
  remove: (deletion: TagDeletion) => Promise<void>;
  cancel: () => void;
}>) => {
  const [deletion, setDeletion] = useState<TagDeletion>({ kind: "Detach" });
  const [pending, setPending] = useState(false);
  const [firstOther] = others;
  const targetItems = others.map((name) => ({ value: name, label: tagLabelOf(name) }));
  const label = tagLabelOf(usage.name);

  const choose = (choice: TagDeletion["kind"]) => {
    switch (choice) {
      case "Detach":
        return setDeletion({ kind: "Detach" });
      case "Reassign":
        // 付け替える選択肢は、他のタグがあるときにだけ出している
        if (firstOther !== undefined) {
          setDeletion({ kind: "Reassign", to: firstOther });
        }
        return;
    }
  };

  return (
    <div
      role="group"
      aria-label={`${label}の削除`}
      className="flex flex-col gap-3 bg-muted/40 px-5 py-4"
    >
      <p className="text-sm">
        {label} を削除します。ついている{entryCountLabelOf(usage.entryCount)}は消えず、タグだけを
        {deletion.kind === "Detach" ? "外します。" : "付け替えます。"}
      </p>
      {firstOther !== undefined && (
        <Segmented
          name="tag-deletion"
          legend="ついている記入のタグ"
          options={DELETION_CHOICES.map((choice) => ({
            value: choice,
            label: choice === "Detach" ? "外すだけ" : "別のタグに付け替える",
          }))}
          value={deletion.kind}
          onChange={choose}
        />
      )}
      {deletion.kind === "Reassign" && (
        <Select
          value={deletion.to}
          items={targetItems}
          onValueChange={(value) => {
            const parsed = v.safeParse(TagName.schema, value);
            if (parsed.success && others.includes(parsed.output)) {
              setDeletion({ kind: "Reassign", to: parsed.output });
            }
          }}
        >
          <SelectTrigger aria-label="付け替え先のタグ" className="min-w-40 self-start">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {targetItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={cancel} disabled={pending}>
          やめる
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void remove(deletion).finally(() => setPending(false));
          }}
        >
          {tagDeletionActionOf(deletion)}
        </Button>
      </div>
    </div>
  );
};

/**
 * タグ（GLOSSARY の「タグの削除」、ADR 0017）。使っているタグとついている記入の数を出し、
 * 使わないタグを削除できる
 */
const TagSection = ({ tagUsage }: Readonly<{ tagUsage: TagUsageState }>) => {
  const { view, remove } = tagUsage;
  const [deleting, setDeleting] = useState<TagName | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const recordStore = useRecordStore();
  return (
    <Section id="settings-tags" title="タグ" perDevice={false}>
      <p className="px-5 py-3.5 text-xs leading-relaxed text-muted-foreground">
        {view.kind === "Loaded" && tagKindsNoteOf(view.tags.length)}
        削除しても記入は消えず、タグだけを外すか、別のタグに付け替えます。
        {recordStore.kind === "Account" && "どの端末でも同じです。"}
      </p>
      {view.kind === "Loaded" ? (
        view.tags.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">まだタグを使っていません</p>
        ) : (
          view.tags.map((usage) =>
            usage.name === deleting ? (
              <TagDeletionForm
                key={usage.name}
                usage={usage}
                others={view.tags.map(({ name }) => name).filter((name) => name !== usage.name)}
                remove={async (deletion) => {
                  setErrorMessage(undefined);
                  const result = await remove(usage.name, deletion);
                  if (Result.isFailure(result)) {
                    setErrorMessage(result.error);
                    return;
                  }
                  setDeleting(undefined);
                }}
                cancel={() => setDeleting(undefined)}
              />
            ) : (
              <Row
                key={usage.name}
                label={tagLabelOf(usage.name)}
                description={entryCountLabelOf(usage.entryCount)}
              >
                <Button
                  variant="outline"
                  aria-label={`${tagLabelOf(usage.name)}を削除`}
                  onClick={() => setDeleting(usage.name)}
                >
                  削除
                </Button>
              </Row>
            ),
          )
        )
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {view.kind === "Loading" ? "読み込み中…" : "読み込めませんでした"}
        </p>
      )}
      {errorMessage !== undefined && (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {errorMessage}
        </p>
      )}
    </Section>
  );
};

/** この端末に残っているセッション1つ。開くと記入の本文を読める。捨てるときは確かめる */
const DeviceSessionRow = ({
  session,
  discard,
}: Readonly<{ session: ClosedSession; discard: () => Promise<boolean> }>) => {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = deviceSessionLabelOf(session, deviceTimeZone());
  const written = session.entries.flatMap((stored) =>
    stored.kind === "Written" ? [stored.entry] : [],
  );
  return (
    <div className="flex flex-col">
      <Row label={label} description={entryCountLabelOf(written.length)}>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            aria-expanded={expanded}
            aria-label={`${label}の記入を${expanded ? "閉じる" : "見る"}`}
            disabled={written.length === 0}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "閉じる" : "記入を見る"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={<Button variant="outline" aria-label={`${label}を捨てる`} />}
            >
              捨てる
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>このセッションを捨てますか？</AlertDialogTitle>
                <AlertDialogDescription>
                  {label}（{entryCountLabelOf(written.length)}）をこの端末から消します。
                  アカウントには取り込まれず、元に戻せません。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>やめる</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => void discard().then((ok) => setFailed(!ok))}
                >
                  捨てる
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Row>
      {expanded && (
        <ul className="flex flex-col gap-3 bg-muted/40 px-5 py-4">
          {written.map((entry) => (
            <li key={entry.id}>
              <ReadOnlyEntry entry={entry} />
            </li>
          ))}
        </ul>
      )}
      {failed && (
        <p role="alert" className="px-5 pb-3 text-sm text-destructive">
          捨てられませんでした。もう一度お試しください。
        </p>
      )}
    </div>
  );
};

/** ログインする前にこの端末で記録した、まだアカウントにないセッション（ADR 0020）。いつでも取り込める */
const DeviceRecordsRows = () => {
  const { state, start, discard } = useImports();
  switch (state.kind) {
    case "Checking":
      return <Row label="この端末の記録" description="読み込み中…" />;
    case "Unreadable":
      return <Row label="この端末の記録" description={deviceUnreadableMessageOf(state.error)} />;
    case "Running":
      return (
        <Row
          label="この端末の記録"
          description={importProgressLabelOf(state.progress.done, state.progress.total)}
        />
      );
    case "Idle": {
      const { sessions, open } = state.records;
      const notes = lastImportLinesOf(state.last, open);
      return (
        <>
          <Row
            label="この端末の記録"
            description={
              sessions.length === 0
                ? "アカウントに取り込んでいない記録はありません"
                : `アカウントに取り込んでいない${deviceRecordsLabelOf(Import.summaryOf(sessions))}があります`
            }
          >
            {sessions.length > 0 && (
              <Button variant="outline" onClick={start}>
                {state.last.kind === "Failed" ? "やり直す" : "取り込む"}
              </Button>
            )}
          </Row>
          {notes.length > 0 && (
            <div className="flex flex-col gap-1 px-5 py-3.5 text-xs leading-relaxed text-muted-foreground">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
          {sessions.map((session) => (
            <DeviceSessionRow
              key={session.id}
              session={session}
              discard={() => discard(session.id)}
            />
          ))}
        </>
      );
    }
  }
};

const AccountSection = () => {
  const recordStore = useRecordStore();
  switch (recordStore.kind) {
    case "Device":
      return (
        <Section id="settings-account" title="アカウント" perDevice={false}>
          <Row
            label="ログインしていません"
            description="記録はこのブラウザに保存されています。ログインすると、他の端末とも同期できます。"
          >
            <LinkButton href="/login" variant="outline">
              ログインして同期
            </LinkButton>
          </Row>
        </Section>
      );
    case "Account":
      return (
        <Section id="settings-account" title="アカウント" perDevice={false}>
          <Row label={recordStore.user.name}>
            <Button variant="outline" onClick={() => void signOut()}>
              ログアウト
            </Button>
          </Row>
          <DeviceRecordsRows />
        </Section>
      );
  }
};

const SECTIONS = [
  { id: "settings-advance", title: "フェーズの進め方" },
  { id: "settings-tasks", title: "ToDo" },
  { id: "settings-alert", title: "知らせ方" },
  { id: "settings-look", title: "表示" },
  { id: "settings-write", title: "記入" },
  { id: "settings-tags", title: "タグ" },
  { id: "settings-account", title: "アカウント" },
] as const;

/**
 * 設定画面（Issue #34）。ホーム画面の上に重ねて出し、開いている間もタイマーと知らせは進む（`OverlayScreen`）
 */
export const SettingsScreen = ({
  phaseAlert,
  advanceMode,
  taskSetting,
  tagUsage,
  timer,
  close,
}: Readonly<{
  phaseAlert: PhaseAlert;
  advanceMode: AdvanceModeState;
  taskSetting: TaskSettingState;
  tagUsage: TagUsageState;
  timer: TimerView;
  close: () => void;
}>) => {
  const recordStore = useRecordStore();
  const sections = SECTIONS.filter(
    (section) => section.id !== "settings-tasks" || recordStore.kind === "Account",
  );
  return (
    <OverlayScreen labelledBy="settings-title" timer={timer} close={close}>
      <div className="mx-auto flex max-w-[960px] gap-10 px-4 py-8 lg:px-8 lg:py-10">
        <nav
          aria-label="設定の項目"
          className="sticky top-24 hidden w-44 shrink-0 flex-col gap-0.5 self-start pt-12 lg:flex"
        >
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className="rounded-lg px-3 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() =>
                document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth" })
              }
            >
              {section.title}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-9">
          <h1 id="settings-title" className="text-[22px] font-bold">
            設定
          </h1>
          <AdvanceSection advanceMode={advanceMode} />
          {recordStore.kind === "Account" && <TaskSection taskSetting={taskSetting} />}
          <AlertSection phaseAlert={phaseAlert} />
          <LookSection />
          <WriteSection />
          <TagSection tagUsage={tagUsage} />
          <AccountSection />
        </div>
      </div>
    </OverlayScreen>
  );
};
