import { useState, type ReactNode } from "react";
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
import {
  notificationPermission,
  requestNotificationPermission,
  type PhaseAlert,
} from "./phase-alert.ts";
import {
  advanceChoiceLabelOf,
  permissionNoteOf,
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
import type { AdvanceModeState } from "./use-advance-mode.ts";
import { useSubmitKey } from "./use-submit-key.ts";
import type { TimerView } from "./use-session-timer.ts";

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

const ADVANCE_CHOICES = ["Auto", "Manual"] as const;

/**
 * フェーズの進め方（GLOSSARY、ADR 0016）。4つの切り替わりごとに自動か手動か。
 * アカウントの設定なので「この端末」の印はつけない。変えるとセッションの途中でもすぐ効く
 */
const AdvanceSection = ({ advanceMode }: Readonly<{ advanceMode: AdvanceModeState }>) => {
  const { view, errorMessage, change } = advanceMode;
  return (
    <Section id="settings-advance" title="フェーズの進め方" perDevice={false}>
      <p className="px-5 py-3.5 text-xs leading-relaxed text-muted-foreground">
        手動にした切り替わりでは、時間が来ると 0:00 で止まって音で知らせ、ボタンを押すまで待ちます。
        どの端末でも同じ設定になります。
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
  { id: "settings-advance", title: "フェーズの進め方" },
  { id: "settings-alert", title: "知らせ方" },
  { id: "settings-look", title: "表示" },
  { id: "settings-write", title: "記入" },
  { id: "settings-account", title: "アカウント" },
] as const;

/**
 * 設定画面（Issue #34）。ホーム画面の上に重ねて出し、開いている間もタイマーと知らせは進む（`OverlayScreen`）
 */
export const SettingsScreen = ({
  phaseAlert,
  advanceMode,
  timer,
  close,
}: Readonly<{
  phaseAlert: PhaseAlert;
  advanceMode: AdvanceModeState;
  timer: TimerView;
  close: () => void;
}>) => (
  <OverlayScreen labelledBy="settings-title" timer={timer} close={close}>
    <div className="mx-auto flex max-w-[960px] gap-10 px-4 py-8 lg:px-8 lg:py-10">
      <nav
        aria-label="設定の項目"
        className="sticky top-24 hidden w-44 shrink-0 flex-col gap-0.5 self-start pt-12 lg:flex"
      >
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
        <AdvanceSection advanceMode={advanceMode} />
        <AlertSection phaseAlert={phaseAlert} />
        <LookSection />
        <WriteSection />
        <AccountSection />
      </div>
    </div>
  </OverlayScreen>
);
