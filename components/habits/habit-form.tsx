"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Habit } from "@/lib/habits/progress";
import { CloseIcon } from "./icons";

export type HabitInput = { name: string; description: string | null; frequency: "daily" | "weekly"; target_per_week: number | null; preferred_time: string | null; color: string | null };
const COLORS = [{value:"#668768", label:"Sage"},{value:"#c89376", label:"Clay"},{value:"#8c86aa", label:"Lavender"},{value:"#7f9fa3", label:"Blue"},{value:"#c2a669", label:"Gold"}];

export function HabitForm({ habit, busy, error, onClose, onSave }: { habit: Habit | null; busy: boolean; error: string; onClose: () => void; onSave: (value: HabitInput) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(habit?.name ?? "");
  const [description, setDescription] = useState(habit?.description ?? "");
  const [frequency, setFrequency] = useState<"daily" | "weekly">(habit?.frequency === "weekly" ? "weekly" : "daily");
  const [target, setTarget] = useState(habit?.target_per_week ?? 3);
  const [time, setTime] = useState(habit?.preferred_time?.slice(0,5) ?? "");
  const [color, setColor] = useState(habit?.color ?? COLORS[0].value);
  const [validation, setValidation] = useState("");
  useEffect(() => { const el=dialog.current; if (el && !el.open) el.showModal(); return () => { if (el?.open) el.close(); }; }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) { setValidation("Please give your habit a name."); return; }
    if (frequency === "weekly" && (!Number.isInteger(target) || target < 1 || target > 7)) { setValidation("Choose a weekly target between 1 and 7 days."); return; }
    setValidation("");
    onSave({ name: name.trim(), description: description.trim() || null, frequency, target_per_week: frequency === "weekly" ? target : null, preferred_time: time || null, color });
  }
  return <dialog ref={dialog} className="habit-dialog" aria-labelledby="habit-form-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="dialog-inner"><header className="dialog-head"><div><p className="dash-eyebrow">{habit ? "MAKE IT YOURS" : "A LITTLE STEP FORWARD"}</p><h2 id="habit-form-title">{habit ? "Edit your habit" : "Create a habit"}</h2><p>Small actions, meaningful change.</p></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={busy}><CloseIcon /></button></header>
    <form className="habit-form" onSubmit={submit}>
      <label className="field"><span>Habit name <span className="required">*</span></span><input autoFocus maxLength={120} required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Take a mindful walk" /></label>
      <label className="field"><span>Description <span className="optional">OPTIONAL</span></span><input maxLength={500} value={description} onChange={e => setDescription(e.target.value)} placeholder="A little note to yourself" /></label>
      <fieldset className="habit-fieldset"><legend>How often?</legend><div className="frequency-options"><label className={frequency === "daily" ? "selected" : ""}><input type="radio" name="frequency" value="daily" checked={frequency === "daily"} onChange={() => setFrequency("daily")} /><strong>Every day</strong><small>A daily practice</small></label><label className={frequency === "weekly" ? "selected" : ""}><input type="radio" name="frequency" value="weekly" checked={frequency === "weekly"} onChange={() => setFrequency("weekly")} /><strong>Weekly goal</strong><small>A few days a week</small></label></div></fieldset>
      {frequency === "weekly" && <label className="field"><span>Days per week</span><select value={target} onChange={e => setTarget(Number(e.target.value))}>{[1,2,3,4,5,6,7].map(n => <option key={n} value={n}>{n} {n === 1 ? "day" : "days"} per week</option>)}</select><small>Weeks run Monday–Sunday. We’ll show it until your goal is met.</small></label>}
      <label className="field"><span>Preferred time <span className="optional">OPTIONAL · LAGOS TIME</span></span><input type="time" value={time} onChange={e => setTime(e.target.value)} /><small>Just a gentle cue — this won’t set a reminder.</small></label>
      <fieldset className="habit-fieldset"><legend>Choose a color <span className="optional">OPTIONAL</span></legend><div className="color-options">{COLORS.map(c => <label key={c.value} className="color-choice" title={c.label}><input type="radio" name="color" value={c.value} checked={color === c.value} onChange={() => setColor(c.value)} /><span style={{background:c.value}}>{color === c.value ? "✓" : ""}</span><span className="sr-only">{c.label}</span></label>)}</div></fieldset>
      {(error || validation) && <div className="notice notice-error" role="alert">{validation || error}</div>}
      <button className="button button-primary button-wide" disabled={busy} type="submit">{busy ? "Saving…" : habit ? "Save changes" : "Create habit"}<span aria-hidden="true">→</span></button>
    </form></div>
  </dialog>;
}
