import { useState } from "react";
import type { WireForm, WireFormField } from "../../src/protocol";
import { rpc } from "../lib/rpc";

/**
 * Native GUI rendering of an agent form request (V2 `form.created`).
 * Replaces the old regex-based "is this a question?" heuristic.
 */
export function FormCard({ form }: { form: WireForm }) {
  const [values, setValues] = useState<
    Record<string, string | number | boolean>
  >(() => {
    const init: Record<string, string | number | boolean> = {};
    for (const f of form.fields) {
      if (f.default !== undefined) init[f.key] = f.default;
    }
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const missing = form.fields.filter(
    (f) => f.required && (values[f.key] === undefined || values[f.key] === ""),
  );

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await rpc.call("form.reply", {
        sessionID: form.sessionID,
        formID: form.id,
        answer: values,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.call("form.cancel", {
        sessionID: form.sessionID,
        formID: form.id,
      });
    } catch {
      /* best-effort */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="perm-card"
      data-action="form"
      style={{ borderLeftColor: "var(--oc2-question)" }}
    >
      <div className="perm-header">
        <span
          className="perm-badge"
          style={{
            color: "var(--oc2-question)",
            borderColor: "var(--oc2-tool-shell-dim)",
          }}
        >
          input
        </span>
        <span>{form.title}</span>
      </div>
      <div className="oc2-form-fields">
        {form.fields.map((f) => (
          <FormFieldRow
            key={f.key}
            field={f}
            value={values[f.key]}
            onChange={(v) =>
              setValues((p) => {
                if (v === undefined) {
                  const next = { ...p };
                  delete next[f.key];
                  return next;
                }
                return { ...p, [f.key]: v };
              })
            }
          />
        ))}
      </div>
      {missing.length > 0 && (
        <div className="perm-hint">
          {missing.length} required field{missing.length === 1 ? "" : "s"}{" "}
          remaining
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
      <div
        className="perm-actions"
        style={{
          borderTop: "1px solid var(--oc2-border)",
          paddingTop: "8px",
          marginTop: "4px",
        }}
      >
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void cancel()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || missing.length > 0}
          onClick={() => void submit()}
        >
          Submit
        </button>
      </div>
    </div>
  );
}

function FormFieldRow({
  field,
  value,
  onChange,
}: {
  field: WireFormField;
  value: string | number | boolean | undefined;
  /** `undefined` clears the field (e.g. a number input emptied by the user). */
  onChange(v: string | number | boolean | undefined): void;
}) {
  const label = (
    <label className="oc2-form-label" title={field.description}>
      {field.title}
      {field.required ? " *" : ""}
    </label>
  );

  if (
    field.options &&
    field.options.length > 0 &&
    (field.type === "string" || field.type === undefined)
  ) {
    return (
      <div className="oc2-form-row">
        {label}
        <select
          className="search"
          value={
            typeof value === "string" ? value : String(field.default ?? "")
          }
          onChange={(e) => onChange(e.target.value)}
        >
          {!field.required && <option value="">—</option>}
          {field.options.map((o, i) => (
            <option key={i} value={String(o.value ?? o.label ?? "")}>
              {o.label ?? String(o.value ?? "")}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <div className="oc2-form-row oc2-form-check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </div>
    );
  }

  return (
    <div className="oc2-form-row">
      {label}
      <input
        className="search"
        type={
          field.type === "number" || field.type === "integer"
            ? "number"
            : "text"
        }
        placeholder={field.placeholder ?? field.description}
        value={
          value === undefined || typeof value === "boolean" ? "" : String(value)
        }
        onChange={(e) =>
          onChange(
            field.type === "number" || field.type === "integer"
              ? // Clearing the field must clear the value, not submit 0.
                e.target.value === ""
                  ? undefined
                  : Number(e.target.value)
              : e.target.value,
          )
        }
      />
    </div>
  );
}
