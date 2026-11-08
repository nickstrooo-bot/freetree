import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { prefixHttps, VOICE_INTRO_MAX_SECONDS } from "@kytelink/schemas";
import { useApp } from "../../../../lib/app-context";
import { useEditor } from "../../../../lib/editor/editor-context";
import { useUsernameAvailability } from "../../../../hooks/use-username-availability";
import { sendEventBeacon } from "../../../../lib/beacons";
import { uploadVoiceIntro } from "../../../../lib/upload/upload-voice-intro";
import { DomainsSection } from "../domains-section";
import { TextInput } from "../../../ui/text-input";
import { Button } from "../../../ui/button";
import { Modal } from "../../../ui/modal";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../../ui/card";
import { Switch } from "../../../ui/switch";
import { Label } from "../../../ui/label";

export function SettingsTab() {
  const router = useRouter();
  const { api, toast, handleError, capabilities } = useApp();
  const { kyte, draft, patchDraft, allows, refresh } = useEditor();

  const [username, setUsername] = useState(kyte.username ?? "");
  const availability = useUsernameAvailability(username, kyte.id);
  const [savingUsername, setSavingUsername] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const canChangeUsername = allows("change_username");
  const removalAttempt = username.trim().length === 0 && kyte.username !== null;
  const readOnly = !allows("edit_draft");

  // Soul features: local state while typing, committed on blur/Enter (same
  // pattern as the username field) so the now-line date stamps the save, not
  // every keystroke.
  const [nowLineText, setNowLineText] = useState(draft.nowLine?.text ?? "");
  const [milestoneGoal, setMilestoneGoal] = useState(
    draft.milestone ? String(draft.milestone.goal) : "",
  );
  const [milestoneLabel, setMilestoneLabel] = useState(draft.milestone?.label ?? "");
  const voiceInput = useRef<HTMLInputElement | null>(null);
  const [voiceUploading, setVoiceUploading] = useState(false);
  const [voiceProgress, setVoiceProgress] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  useEffect(() => {
    setNowLineText(draft.nowLine?.text ?? "");
  }, [draft.nowLine]);

  useEffect(() => {
    setMilestoneGoal(draft.milestone ? String(draft.milestone.goal) : "");
    setMilestoneLabel(draft.milestone?.label ?? "");
  }, [draft.milestone]);

  function commitNowLine() {
    if (readOnly) return;
    const text = nowLineText.trim();
    if (!text) {
      if (draft.nowLine) patchDraft({ nowLine: null });
      return;
    }
    if (draft.nowLine?.text === text) return;
    patchDraft({ nowLine: { text, updatedAt: new Date().toISOString() } });
  }

  function commitMilestone() {
    if (readOnly) return;
    const goal = Math.round(Number(milestoneGoal));
    if (!milestoneGoal.trim() || !Number.isFinite(goal) || goal < 1 || goal > 100_000) {
      if (draft.milestone) patchDraft({ milestone: null });
      return;
    }
    const label = milestoneLabel.trim() || undefined;
    if (draft.milestone?.goal === goal && (draft.milestone?.label ?? undefined) === label) {
      return;
    }
    patchDraft({ milestone: { goal, label } });
  }

  async function onVoiceFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || readOnly) return;
    setVoiceError(null);
    setVoiceUploading(true);
    setVoiceProgress(0);
    try {
      const result = await uploadVoiceIntro(api, kyte.id, file, (pct) => setVoiceProgress(pct));
      patchDraft({ voiceIntro: { url: result.url } });
      toast("Voice intro saved to your draft. Publish to make it live.", "success");
      await refresh();
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setVoiceUploading(false);
    }
  }

  async function removeVoiceIntro() {
    if (readOnly) return;
    try {
      await api.assets.clearVoiceIntro({ kyteId: kyte.id });
      patchDraft({ voiceIntro: null });
      toast("Voice intro removed.", "success");
      await refresh();
    } catch (error) {
      handleError(error);
    }
  }

  async function commitUsername() {
    const next = username.trim();
    if (
      !canChangeUsername ||
      savingUsername ||
      availability.status !== "available" ||
      next.toLowerCase() === (kyte.username ?? "").toLowerCase()
    ) {
      return;
    }
    setSavingUsername(true);
    try {
      await api.kyte.changeUsername({ kyteId: kyte.id, username: next });
      sendEventBeacon("username_updated");
      await refresh();
      toast("Username updated", "success");
    } catch (error) {
      handleError(error);
    } finally {
      setSavingUsername(false);
    }
  }

  async function deleteKyte() {
    try {
      await api.kyte.delete({ kyteId: kyte.id, confirm: confirmText });
      toast("Kyte deleted", "success");
      void router.push("/edit");
    } catch (error) {
      handleError(error);
    }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kytelink-${kyte.username ?? kyte.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Username</CardTitle>
          <CardDescription>
            Change it anytime — it goes live the moment it&apos;s available.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TextInput
            leftAddon="getfreetree.com/"
            value={username}
            disabled={!canChangeUsername}
            onChange={(event) => setUsername(event.target.value)}
            onBlur={() => void commitUsername()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
                void commitUsername();
              }
            }}
            status={
              removalAttempt
                ? "invalid"
                : availability.status === "available"
                  ? "valid"
                  : availability.status === "unavailable"
                    ? "invalid"
                    : "default"
            }
            error={
              removalAttempt
                ? "You can't remove your username — pick a new one instead."
                : availability.reason
            }
          />
        </CardContent>
      </Card>

      {allows("manage_domains") || kyte.username ? <DomainsSection /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Redirect</CardTitle>
          <CardDescription>Send visitors straight to another URL.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <TextInput
              placeholder="https://yourwebsite.com"
              value={draft.redirectUrl ?? ""}
              onChange={(event) =>
                patchDraft({
                  redirectUrl: event.target.value || null,
                  shouldRedirect: event.target.value ? draft.shouldRedirect : false,
                })
              }
            />
            <div className="flex items-center gap-2">
              <Switch
                id="redirect-toggle"
                checked={draft.shouldRedirect}
                disabled={!draft.redirectUrl}
                onCheckedChange={(checked) => patchDraft({ shouldRedirect: checked })}
              />
              <Label htmlFor="redirect-toggle" className="text-muted-foreground">
                {draft.shouldRedirect ? "On" : "Off"}
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SEO</CardTitle>
          <CardDescription>Best to leave as is.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <TextInput
              label="Title"
              placeholder="My short title (55–60 characters)"
              value={draft.seoTitle ?? ""}
              onChange={(event) => patchDraft({ seoTitle: event.target.value || null })}
            />
            <TextInput
              label="Description"
              placeholder="My short description (155–160 characters)"
              value={draft.seoDescription ?? ""}
              onChange={(event) =>
                patchDraft({ seoDescription: event.target.value || null })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live badge</CardTitle>
          <CardDescription>
            Show a red “LIVE NOW” pill on your page when your YouTube channel is
            live. Checked every couple of minutes — no API key needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <TextInput
              label="YouTube channel"
              placeholder="https://www.youtube.com/@yourchannel"
              value={draft.liveBadge?.youtubeChannelUrl ?? ""}
              onChange={(event) => {
                const raw = event.target.value.trim();
                if (!raw) {
                  patchDraft({ liveBadge: null });
                  return;
                }
                // A bare @handle becomes a full channel URL; anything else gets
                // the usual https prefix. The live check accepts both forms.
                const channelUrl = raw.startsWith("@")
                  ? `https://www.youtube.com/${raw}`
                  : prefixHttps(raw);
                patchDraft({
                  liveBadge: {
                    enabled: draft.liveBadge?.enabled ?? true,
                    youtubeChannelUrl: channelUrl,
                  },
                });
              }}
              onBlur={() => {
                const url = draft.liveBadge?.youtubeChannelUrl ?? "";
                if (url && !/youtube\.com|youtu\.be/i.test(url)) {
                  toast("That doesn't look like a YouTube channel link", "error");
                  patchDraft({ liveBadge: null });
                }
              }}
            />
            <div className="flex items-center gap-2">
              <Switch
                id="live-badge-toggle"
                checked={draft.liveBadge?.enabled ?? false}
                disabled={!draft.liveBadge?.youtubeChannelUrl}
                onCheckedChange={(checked) => {
                  if (draft.liveBadge) {
                    patchDraft({ liveBadge: { ...draft.liveBadge, enabled: checked } });
                  }
                }}
              />
              <Label htmlFor="live-badge-toggle" className="text-muted-foreground">
                {draft.liveBadge?.enabled ? "On" : "Off"}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              If YouTube blocks the check from the server, the badge just stays off —
              it never shows the wrong state.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About you</CardTitle>
          <CardDescription>
            A few lines about who you are, shown at the top of your page, above
            your links. Your photo is the avatar from the Design tab.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            value={draft.about ?? ""}
            disabled={readOnly}
            onChange={(event) => patchDraft({ about: event.target.value || null })}
            maxLength={1000}
            rows={3}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            placeholder="Who you are, what you make, why it matters…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Now line</CardTitle>
          <CardDescription>
            One short line about what you&apos;re up to this week. The date it
            was written shows next to it, so a stale line is visibly stale.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <TextInput
              placeholder="This week I'm finishing…"
              value={nowLineText}
              disabled={readOnly}
              onChange={(event) => setNowLineText(event.target.value)}
              onBlur={() => void commitNowLine()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                  commitNowLine();
                }
              }}
            />
            {draft.nowLine ? (
              <p className="text-xs text-muted-foreground">
                Written{" "}
                {new Date(draft.nowLine.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                . Clear the line to remove it.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Milestone</CardTitle>
          <CardDescription>
            A goal bar on your page — “help me reach 100 supporters”. The
            number counts itself from your completed sales and tips; you only
            set the goal, never the count.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex gap-3">
              <TextInput
                label="Goal"
                type="number"
                placeholder="100"
                value={milestoneGoal}
                disabled={readOnly}
                onChange={(event) => setMilestoneGoal(event.target.value)}
                onBlur={() => void commitMilestone()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                    commitMilestone();
                  }
                }}
              />
              <TextInput
                label="Label"
                placeholder="supporters"
                value={milestoneLabel}
                disabled={readOnly}
                onChange={(event) => setMilestoneLabel(event.target.value)}
                onBlur={() => void commitMilestone()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                    commitMilestone();
                  }
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              So far: {kyte.supporterCount} completed{" "}
              {kyte.supporterCount === 1 ? "sale or tip" : "sales and tips"}. Clear
              the goal to remove the meter.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Voice intro</CardTitle>
          <CardDescription>
            A short clip of you — 10 to 30 seconds, mp3 or m4a, max{" "}
            {VOICE_INTRO_MAX_SECONDS} seconds. Visitors get a play button under
            your photo. It never auto-plays.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {draft.voiceIntro ? (
              <>
                <audio controls preload="none" src={draft.voiceIntro.url} className="w-full" />
                {!readOnly ? (
                  <div>
                    <Button variant="secondary" size="sm" onClick={() => void removeVoiceIntro()}>
                      Remove voice intro
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
            {capabilities.uploads && !readOnly ? (
              <>
                <input
                  ref={voiceInput}
                  type="file"
                  accept=".mp3,.m4a,audio/mpeg,audio/mp4"
                  hidden
                  onChange={(event) => void onVoiceFile(event)}
                />
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={voiceUploading}
                    onClick={() => voiceInput.current?.click()}
                  >
                    {voiceUploading
                      ? `Uploading… ${voiceProgress}%`
                      : draft.voiceIntro
                        ? "Replace voice intro"
                        : "Upload a voice intro"}
                  </Button>
                </div>
              </>
            ) : null}
            {voiceError ? <p className="text-sm text-red-600">{voiceError}</p> : null}
          </div>
        </CardContent>
      </Card>

      <Card className="flex items-center justify-between gap-4 p-5">
        <div>
          <div className="text-ink text-[13px] font-semibold">FreeTree badge</div>
          <p className="text-tertiary mt-1 text-xs">
            The small &quot;made with kytelink&quot; line at the bottom of your page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="watermark-toggle"
            checked={!draft.hideWatermark}
            onCheckedChange={(checked) => patchDraft({ hideWatermark: !checked })}
          />
          <Label htmlFor="watermark-toggle" className="text-muted-foreground">
            {draft.hideWatermark ? "Off" : "On"}
          </Label>
        </div>
      </Card>

      <Card className="flex items-center justify-between gap-4 p-5">
        <div>
          <div className="text-ink text-[13px] font-semibold">Export this kyte</div>
          <p className="text-tertiary mt-1 text-xs">
            Its links and settings, as JSON. It&apos;s yours.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={exportData}>
          Download
        </Button>
      </Card>

      {allows("delete_kyte") ? (
        <Card className="border-danger-border flex items-center justify-between gap-4 p-5">
          <div>
            <div className="text-danger text-[13px] font-semibold">
              Delete this FreeTree
            </div>
            <p className="text-tertiary mt-1 text-xs">Gone for good. No dark patterns.</p>
          </div>
          <Button variant="danger" size="sm" onClick={() => setDeleteModal(true)}>
            Delete
          </Button>
        </Card>
      ) : null}

      <Modal
        open={deleteModal}
        onClose={() => setDeleteModal(false)}
        title="Delete this kyte"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteModal(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={deleteKyte}
              disabled={confirmText !== kyte.username}
            >
              Delete forever
            </Button>
          </div>
        }
      >
        <p className="text-muted-foreground mb-3 text-sm">
          This can&apos;t be undone. Type{" "}
          <span className="text-foreground font-semibold">{kyte.username}</span> to
          confirm.
        </p>
        <TextInput
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
        />
      </Modal>
    </div>
  );
}
