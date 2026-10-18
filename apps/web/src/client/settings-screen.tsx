import { useState, type ReactNode } from "react";
import { ChevronLeftIcon, PlayIcon } from "lucide-react";
import * as v from "valibot";
import {
  ALERT_TONES,
  toneFor,
  useAlertSettings,
  VOLUMES,
  withTone,
  type AlertTone,
} from "./alert-settings.ts";
import { authClient, signOut } from "./auth-client.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { cn } from "@/client/lib/utils";
import {
  notificationPermission,
  requestNotificationPermission,
  type PhaseAlert,
} from "./phase-alert.ts";
import {
  backgroundTimerLabelOf,
  permissionNoteOf,
  themeLabelOf,
  TONE_TARGETS,
  toneLabelOf,
  toneTargetOf,
  volumeLabelOf,
} from "./settings-text.ts";
import { modifierLabelOf, SubmitKeySchema, submitKeyLabelOf } from "./submit-key.ts";
import { THEME_PREFERENCES, useThemePreference } from "./theme.ts";
import { useSubmitKey } from "./use-submit-key.ts";
import type { TimerView } from "./use-session-timer.ts";

const modifierLabel = modifierLabelOf(navigator.userAgent);

const AlertToneSchema = v.picklist(ALERT_TONES);

const toneItems = ALERT_TONES.map((tone) => ({ value: tone, label: toneLabelOf(tone) }));

/** 選択肢を横に並べた切り替え（ラジオボタン）。見た目はモックのセグメント */
const Segmented = <T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  disabled = false,
}: Readonly<{
  name: string;
  legend: string;
  options: ReadonlyArray<Readonly<{ value: T; label: string }>>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}>) => (
  <fieldset
    disabled={disabled}
    className="flex flex-wrap gap-0.5 rounded-[10px] bg-muted p-[3px] disabled:opacity-50"
  >
    <legend className="sr-only">{legend}</legend>
    {options.map((option) => (
      <label
        key={option.value}
        className={cn(
          "flex h-[34px] cursor-pointer items-center rounded-lg px-3.5 text-[13px] text-muted-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
          option.value === value && "bg-card font-semibold text-foreground shadow-xs",
        )}
      >
        <input
          type="radio"
          name={name}
          className="sr-only"
          checked={option.value === value}
          onChange={() => onChange(option.value)}
        />
        {option.label}
      </label>
    ))}
  </fieldset>
);

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
}: Readonly<{ label: string; description?: string | undefined; children: ReactNode }>) => (
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

const AccountSection = () => {
  const { data: session } = authClient.useSession();
  const name = session?.user.name;
  return (
    <Section id="settings-account" title="アカウント" perDevice={false}>
      <Row label={name ?? "読み込み中…"}>
        <Button variant="outline" onClick={() => void signOut()}>
          ログアウト
        </Button>
      </Row>
    </Section>
  );
};

const SECTIONS = [
  { id: "settings-alert", title: "知らせ方" },
  { id: "settings-look", title: "表示" },
  { id: "settings-write", title: "記入" },
  { id: "settings-account", title: "アカウント" },
] as const;

/**
 * 設定画面（Issue #34）。ホーム画面の上に重ねて出し、ホーム画面は閉じない。
 * タイマー・フェーズの切り替わりの知らせ・Wake Lock・同期はホーム画面が持っているので、
 * 設定画面を開いている間も止まらずに進む。
 */
export const SettingsScreen = ({
  phaseAlert,
  timer,
  close,
}: Readonly<{ phaseAlert: PhaseAlert; timer: TimerView; close: () => void }>) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    className="fixed inset-0 z-40 overflow-y-auto bg-background"
    onKeyDown={(event) => {
      // 音色の選択肢（別の場所に描く）の中の Escape は、選択肢を閉じるだけにする
      const inScreen = event.target instanceof Node && event.currentTarget.contains(event.target);
      if (event.key === "Escape" && inScreen) {
        close();
      }
    }}
  >
    <header className="sticky top-0 z-10 border-b bg-card">
      <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between gap-4 px-2 lg:h-16 lg:px-6">
        <Button variant="ghost" size="lg" autoFocus onClick={close}>
          <ChevronLeftIcon />
          タイマーに戻る
        </Button>
        {timer.kind === "InSession" && (
          <p className="truncate text-xs text-muted-foreground">
            <span className="hidden sm:inline">セッションは裏で進み続けます · </span>
            <span className="font-mono">{backgroundTimerLabelOf(timer.state)}</span>
          </p>
        )}
      </div>
    </header>
    <div className="mx-auto flex max-w-[960px] gap-10 px-4 py-8 lg:px-8 lg:py-10">
      <nav aria-label="設定の項目" className="hidden w-44 shrink-0 flex-col gap-0.5 pt-12 lg:flex">
        {SECTIONS.map((section) => (
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
        <AlertSection phaseAlert={phaseAlert} />
        <LookSection />
        <WriteSection />
        <AccountSection />
      </div>
    </div>
  </div>
);
