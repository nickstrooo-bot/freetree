import { useRef, useState } from "react";
import { prefixHttps, type Link, type LinkCard } from "@kytelink/schemas";
import { Plus } from "lucide-react";
import { useApp } from "../../../lib/app-context";
import { getTrpcClient } from "../../../lib/api/trpc";
import { Modal } from "../../ui/modal";
import { Button } from "../../ui/button";
import { TextInput } from "../../ui/text-input";
import { LinkEmoji } from "../../shared/link-emoji";
import { FaIcon } from "../../shared/fa-icon";
import { cn } from "@/lib/cn";

const ICON_CHOICES = [
  "FaLinkedin",
  "FaInstagram",
  "FaSoundcloud",
  "FaTwitter",
  "FaDiscord",
  "FaGithub",
  "FaGlobe",
  "FaSnapchat",
  "FaYoutube",
  "FaMedium",
  "FaTwitch",
  "FaSpotify",
];

const EMOJI_CHOICES = ["🤘", "🦄", "👻", "🌶", "🪁", "📞", "🚢", "👋", "🥶", "✉️", "🙉", "📆"];

export interface LinkModalProps {
  open: boolean;
  initial: Link | null;
  onClose: () => void;
  onSave: (link: Link) => void;
  onDelete?: () => void;
}

type FetchState = "idle" | "loading" | "done" | "error";

export function LinkModal({ open, initial, onClose, onSave, onDelete }: LinkModalProps) {
  const { toast } = useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [url, setUrl] = useState(initial?.link ?? "");
  const [emoji, setEmoji] = useState<string | undefined>(initial?.emoji);
  const [picker, setPicker] = useState<"icon" | "emoji" | "image" | null>(null);
  // Photo link-card: OpenGraph metadata fetched for the pasted URL. Stored on
  // the link at save time; the public profile renders it as a rich card.
  const [card, setCard] = useState<LinkCard | null>(initial?.card ?? null);
  const [fetchState, setFetchState] = useState<FetchState>("idle");

  function reset() {
    setTitle(initial?.title ?? "");
    setUrl(initial?.link ?? "");
    setEmoji(initial?.emoji);
    setPicker(null);
    setCard(initial?.card ?? null);
    setFetchState("idle");
  }

  function close() {
    reset();
    onClose();
  }

  function save() {
    if (!title.trim()) {
      toast("Add a title for this link", "error");
      return;
    }
    if (!url.trim() || !url.includes(".")) {
      toast("Add a valid link", "error");
      return;
    }
    onSave({
      title: title.trim(),
      link: prefixHttps(url.trim()),
      emoji,
      ...(card ? { card } : {}),
    });
    close();
  }

  // Fetch the page's OpenGraph metadata (og:title / og:description /
  // og:image) and pre-fill the card. An empty title is filled from the
  // page; a title the seller already typed is never overwritten. A missing
  // preview is not an error — the link still saves with the manual title.
  async function fetchPreview() {
    if (!url.trim() || !url.includes(".")) {
      toast("Add a link first", "error");
      return;
    }
    setFetchState("loading");
    try {
      const result = await getTrpcClient().linkCard.fetch.mutate({
        url: prefixHttps(url.trim()),
      });
      if (!result.card) {
        setCard(null);
        setFetchState("error");
        return;
      }
      setCard(result.card);
      setFetchState("done");
      if (!title.trim() && result.card.title) setTitle(result.card.title);
    } catch {
      setFetchState("error");
      toast("Couldn't fetch a preview for this link", "error");
    }
  }

  function onImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setEmoji(reader.result as string);
      setPicker(null);
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={initial ? "Edit link" : "Add link"}
      footer={
        <div className="flex items-center justify-between">
          {onDelete ? (
            <Button
              variant="danger-ghost"
              size="sm"
              onClick={() => {
                onDelete();
                close();
              }}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={save}>Save</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPicker(picker ? null : "icon")}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border bg-tint text-subtle-foreground outline-none transition-colors hover:border-accent"
            aria-label="Choose icon, emoji or image"
          >
            {emoji ? <LinkEmoji emoji={emoji} size={24} /> : <Plus className="size-4" />}
          </button>
          <div className="flex-1">
            <TextInput
              placeholder="Link title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && save()}
            />
          </div>
        </div>

        <TextInput
          placeholder="https://…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
        />

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchPreview}
            disabled={fetchState === "loading"}
          >
            {fetchState === "loading" ? "Fetching preview…" : "Fetch preview"}
          </Button>
          {fetchState === "error" ? (
            <span className="text-xs text-tertiary">No preview found — your title still works.</span>
          ) : null}
        </div>

        {card ? (
          <div className="overflow-hidden rounded-md border border-border">
            {card.image ? (
              <img
                src={card.image}
                alt=""
                className="h-[120px] w-full object-cover"
                loading="lazy"
              />
            ) : null}
            <div className="flex flex-col gap-1 p-3">
              <span className="text-sm font-medium text-ink">{card.title ?? title}</span>
              {card.description ? (
                <span className="text-xs leading-relaxed text-tertiary">{card.description}</span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setCard(null);
                  setFetchState("idle");
                }}
                className="self-start text-xs font-medium text-accent outline-none hover:text-accent-hover"
              >
                Remove preview
              </button>
            </div>
          </div>
        ) : null}

        {picker ? (
          <div className="rounded-md border border-border p-3">
            <div className="mb-3 flex gap-2">
              {(["icon", "emoji", "image"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPicker(mode)}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm capitalize outline-none",
                    picker === mode ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
            {picker === "icon" ? (
              <div className="grid grid-cols-4 gap-2">
                {ICON_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => {
                      setEmoji(choice);
                      setPicker(null);
                    }}
                    className="flex h-11 items-center justify-center rounded-md border border-border text-foreground outline-none hover:border-accent"
                  >
                    <FaIcon name={choice} size={20} />
                  </button>
                ))}
              </div>
            ) : null}
            {picker === "emoji" ? (
              <div className="grid grid-cols-6 gap-2">
                {EMOJI_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => {
                      setEmoji(choice);
                      setPicker(null);
                    }}
                    className="flex h-11 items-center justify-center rounded-md border border-border text-xl outline-none hover:border-accent"
                  >
                    {choice}
                  </button>
                ))}
              </div>
            ) : null}
            {picker === "image" ? (
              <div>
                <input ref={fileInput} type="file" accept="image/*" hidden onChange={onImage} />
                <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                  Upload your own image
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
