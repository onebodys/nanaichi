import { useEffect, useState } from "react";
import * as v from "valibot";
import { authClient } from "./auth-client.ts";
import { Button } from "./components/ui/button.tsx";
import { redirectHostOf, scopeDescriptionsOf } from "./consent-text.ts";
import { LogoMark } from "./logo-mark.tsx";

/**
 * MCP クライアントの公開情報（`/api/auth/oauth2/public-client`）。名前はクライアントが動的登録で
 * 名乗ったものなので、外から来る値としてスキーマで検証する
 */
const PublicClientSchema = v.object({ client_name: v.optional(v.string()) });

/** 許可・拒否の結果、MCP クライアントへ戻す先（`/api/auth/oauth2/consent`） */
const ConsentedSchema = v.object({ url: v.string() });

type ClientState =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "Found"; name: string }>
  | Readonly<{ kind: "NotFound" }>;

type Decision =
  | Readonly<{ kind: "Undecided" }>
  | Readonly<{ kind: "Sending" }>
  | Readonly<{ kind: "Failed" }>;

type ConsentPageProps = Readonly<{
  /** URL の `client_id`・`scope`・`redirect_uri`。認可の入口が署名して付ける */
  clientId: string | undefined;
  scope: string | undefined;
  redirectUri: string | undefined;
}>;

/**
 * 連携の許可の画面（GLOSSARY「連携の許可」、ADR 0017）。
 *
 * MCP クライアントの認可の途中で、ログイン済みのユーザーが開く。許可するか拒否するかを送ると、
 * サーバーが MCP クライアントへ戻す URL を返すので、そこへ移る。どちらを選んでも MCP クライアントへ戻る。
 * 送るリクエストには、`oauthProviderClient` が URL の署名つきのクエリを添える（auth-client.ts）。
 */
export const ConsentPage = ({ clientId, scope, redirectUri }: ConsentPageProps) => {
  const [client, setClient] = useState<ClientState>({ kind: "Loading" });
  const [decision, setDecision] = useState<Decision>({ kind: "Undecided" });

  useEffect(() => {
    if (clientId === undefined) {
      setClient({ kind: "NotFound" });
      return;
    }
    void authClient.oauth2.publicClient({ query: { client_id: clientId } }).then(({ data }) => {
      const parsed = v.safeParse(PublicClientSchema, data);
      setClient(
        parsed.success
          ? { kind: "Found", name: parsed.output.client_name ?? "名前のないクライアント" }
          : { kind: "NotFound" },
      );
    });
  }, [clientId]);

  const decide = async (accept: boolean) => {
    setDecision({ kind: "Sending" });
    const { data } = await authClient.oauth2.consent({ accept });
    const parsed = v.safeParse(ConsentedSchema, data);
    if (!parsed.success) {
      setDecision({ kind: "Failed" });
      return;
    }
    window.location.href = parsed.output.url;
  };

  const redirectHost = redirectHostOf(redirectUri);
  const sending = decision.kind === "Sending";

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-4">
          <LogoMark className="size-14 rounded-2xl text-lg" />
          <h1 className="text-2xl font-bold tracking-tight">連携の許可</h1>
        </div>

        <div className="flex w-full flex-col gap-5 rounded-2xl border bg-card p-5 shadow-xs">
          {client.kind === "Loading" && (
            <p className="text-center text-sm text-muted-foreground">読み込んでいます…</p>
          )}

          {client.kind === "NotFound" && (
            <p role="alert" className="text-center text-sm text-destructive">
              連携するクライアントが見つかりません。もう一度つなぎ直してください。
            </p>
          )}

          {client.kind === "Found" && (
            <>
              <p className="text-[15px] leading-relaxed">
                <span className="font-semibold break-all">{client.name}</span> が、あなたの nanaichi
                の記録を読もうとしています。
              </p>

              <ul className="flex flex-col gap-2 text-sm">
                {scopeDescriptionsOf(scope).map((description) => (
                  <li key={description} className="flex gap-2">
                    <span aria-hidden className="text-muted-foreground">
                      ・
                    </span>
                    {description}
                  </li>
                ))}
              </ul>

              <p className="text-xs leading-relaxed text-muted-foreground">
                記録を書き換えることはできません。
                {redirectHost !== undefined && (
                  <>
                    許可すると{" "}
                    <span className="inline-block max-w-full font-mono break-all">
                      {redirectHost}
                    </span>{" "}
                    に戻ります。心当たりがなければ拒否してください。
                  </>
                )}
              </p>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  size="lg"
                  className="flex-1"
                  disabled={sending}
                  onClick={() => void decide(false)}
                >
                  拒否する
                </Button>
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={sending}
                  onClick={() => void decide(true)}
                >
                  許可する
                </Button>
              </div>

              {decision.kind === "Failed" && (
                <p role="alert" className="text-center text-sm text-destructive">
                  送れませんでした。もう一度つなぎ直してください。
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
};
