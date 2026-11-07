import { useState } from "react";
import { prefixHttps, type ScheduledBlock } from "@kytelink/schemas";
import { useApp } from "../../../lib/app-context";
import { Modal } from "../../ui/modal";
import { Button } from "../../ui/button";
import { TextInput } from "../../ui/text-input";

export interface ScheduledBlockModalProps {
  open: boolean;
  initial: ScheduledBlock | null;
  onClose: () => void;
  onSave: (block: ScheduledBlock) => void;
  onDelete?: () => void;
}

// datetime-local has no timezone: `new Date(value)` reads it as local time and
// toISOString() stores UTC — the same conversion the publish scheduler uses
// (schedule-panel.tsx). Back the other way for editing.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduledBlockModal({ open, initial, onClose, onSave, onDelete }: ScheduledBlockModalProps) {
  const { toast } = useApp();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [label, setLabel] = useState(initial?.label ?? "Coming soon");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [startsAt, setStartsAt] = useState(initial ? toLocalInput(initial.startsAt) : "");
  const [endsAt, setEndsAt] = useState(initial?.endsAt ? toLocalInput(initial.endsAt) : "");
  const [showCountdown, setShowCountdown] = useState(initial?.showCountdown ?? true);

  function reset() {
    setUrl(initial?.url ?? "");
    setLabel(initial?.label ?? "Coming soon");
    setDescription(initial?.description ?? "");
    setStartsAt(initial ? toLocalInput(initial.startsAt) : "");
    setEndsAt(initial?.endsAt ? toLocalInput(initial.endsAt) : "");
    setShowCountdown(initial?.showCountdown ?? true);
  }

  function close() {
    reset();
    onClose();
  }

  function save() {
    if (!url.trim() || !url.includes(".")) {
      toast("Add a valid link", "error");
      return;
    }
    const trimmedLabel = label.trim() || "Coming soon";
    if (trimmedLabel.length > 60) {
      toast("Button label must be under 60 characters", "error");
      return;
    }
    const start = new Date(startsAt);
    if (!startsAt || Number.isNaN(start.getTime())) {
      toast("Pick when this block goes live", "error");
      return;
    }
    let end: Date | null = null;
    if (endsAt) {
      end = new Date(endsAt);
      if (Number.isNaN(end.getTime())) {
        toast("Pick a valid end time, or leave it blank", "error");
        return;
      }
      if (end.getTime() <= start.getTime()) {
        toast("The end time has to be after the start time", "error");
        return;
      }
    }
    onSave({
      url: prefixHttps(url.trim()),
      label: trimmedLabel,
      description: description.trim() || undefined,
      startsAt: start.toISOString(),
      endsAt: end ? end.toISOString() : null,
      showCountdown,
    });
    close();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={initial ? "Edit scheduled block" : "Add scheduled block"}
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
        <TextInput
          placeholder="Link URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
        />
        <TextInput
          placeholder="Button label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
          maxLength={60}
        />
        <TextInput
          placeholder="Description (optional)"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
          maxLength={200}
        />
        <TextInput
          label="Goes live at"
          type="datetime-local"
          value={startsAt}
          onChange={(event) => setStartsAt(event.target.value)}
        />
        <TextInput
          label="Disappears at (optional)"
          type="datetime-local"
          value={endsAt}
          onChange={(event) => setEndsAt(event.target.value)}
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={showCountdown}
            onChange={(event) => setShowCountdown(event.target.checked)}
            className="size-4 accent-current"
          />
          Show a countdown before it goes live
        </label>
        <p className="text-xs text-muted-foreground">
          Visitors see a countdown until the start time, then a normal button. After
          the end time (if you set one) the block disappears. Times are in your local
          timezone.
        </p>
      </div>
    </Modal>
  );
}
