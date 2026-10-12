import { useId, useState } from 'react';
import type { Field, FieldValue } from '@soulstream/chat-ui';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { useChatTypography } from '../chat/useChatTypography';

type FieldProps = { field: Field; value: FieldValue; label: string; onChange: (value: FieldValue) => void };

export function ChatUiCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  const id = useId();
  return <div className="chat-ui-choice"><Checkbox id={id} checked={checked} onCheckedChange={onChange} /><label htmlFor={id}>{label}</label></div>;
}

function NumberField({ field, value, label, onChange }: FieldProps & { field: Extract<Field, { type: 'number' }> }) {
  const id = useId();
  const [buffer, setBuffer] = useState<{ text: string; value: FieldValue } | null>(null);
  // Unfinished number input belongs to this control, never to calculation state.
  const text = buffer && buffer.value === value ? buffer.text : String(value);
  return <div className="chat-ui-field"><label htmlFor={id}>{label}</label>
    <Input id={id} type="number" value={text} min={field.min} max={field.max} step={field.step}
      onChange={event => {
        const next = event.target.value;
        const number = Number(next);
        if (next.trim() && Number.isFinite(number)) { setBuffer(null); onChange(number); }
        else setBuffer({ text: next, value });
      }} onBlur={() => setBuffer(null)} />
  </div>;
}

export function ChatUiField({ field, value, label, onChange }: FieldProps) {
  const id = useId();
  const { chatTypographyStyle } = useChatTypography();
  switch (field.type) {
    case 'number': return <NumberField field={field} value={value} label={label} onChange={onChange} />;
    case 'text': return <div className="chat-ui-field"><label htmlFor={id}>{label}</label><Input id={id} type="text" value={String(value)} maxLength={field.maxLength} onChange={event => onChange(event.target.value)} /></div>;
    case 'boolean': return <ChatUiCheckbox label={label} checked={value === true} onChange={onChange} />;
    case 'choice': return <div className="chat-ui-field"><label id={id}>{label}</label>
      <Select value={String(value)} onValueChange={next => { if (next !== null) onChange(next); }} items={field.options.map(option => ({ value: option.id, label: option.label }))}>
        <SelectTrigger aria-labelledby={id}><SelectValue /></SelectTrigger>
        <SelectPopup className="chat-ui-select-options" style={{ ...chatTypographyStyle, fontSize: 'var(--chat-font-size)', lineHeight: 'var(--chat-line-height)' }}>
          {field.options.map(option => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
        </SelectPopup>
      </Select>
    </div>;
    case 'selection': {
      const selection = value as string[];
      return <fieldset><legend>{label}</legend><div className="chat-ui-field">{field.options.map(option =>
        <ChatUiCheckbox key={option.id} label={option.label} checked={selection.includes(option.id)} onChange={checked => onChange(checked ? [...selection, option.id] : selection.filter(id => id !== option.id))} />
      )}</div></fieldset>;
    }
  }
}
