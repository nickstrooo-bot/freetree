import { useState } from "react";
import { prefixHttps, type BookingBlock } from "@kytelink/schemas";
import { useApp } from "../../../lib/app-context";
import { Modal } from "../../ui/modal";
import { Button } from "../../ui/button";
import { TextInput } from "../../ui/text-input";

export interface BookingModalProps {
  open: boolean;
  initial: BookingBlock | null;
  onClose: () => void;
  onSave: (block: BookingBlock) => void;
  onDelete?: () => void;
}

export function BookingModal({ open, initial, onClose, onSave, onDelete }: BookingModalProps) {
  const { toast } = useApp();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [label, setLabel] = useState(initial?.label ?? "Book now");
  const [description, setDescription] = useState(initial?.description ?? "");

  function reset() {
    setUrl(initial?.url ?? "");
    setLabel(initial?.label ?? "Book now");
    setDescription(initial?.description ?? "");
  }

  function close() {
    reset();
    onClose();
  }

  function save() {
    if (!url.trim() || !url.includes(".")) {
      toast("Add a valid booking link", "error");
      return;
    }
    const trimmedLabel = label.trim() || "Book now";
    if (trimmedLabel.length > 60) {
      toast("Button label must be under 60 characters", "error");
      return;
    }
    onSave({
      url: prefixHttps(url.trim()),
      label: trimmedLabel,
      description: description.trim() || undefined,
    });
    close();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={initial ? "Edit booking button" : "Add booking button"}
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
          placeholder="Booking URL (Calendly, Cal.com, …)"
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
        <p className="text-xs text-muted-foreground">
          Paste your scheduling link from Calendly, Cal.com, or any booking tool. Visitors
          get a prominent button that opens it in a new tab.
        </p>
      </div>
    </Modal>
  );
}
