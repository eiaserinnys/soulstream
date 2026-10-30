ALTER TABLE conversation_bindings
  ADD COLUMN first_input_is_initial_instruction BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE conversation_bindings AS binding
SET notices = COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', 'notice:' || (entry.ordinality - 1)::text,
    'text', entry.value,
    'at', to_char(COALESCE(session.created_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY entry.ordinality)
  FROM jsonb_array_elements_text(binding.notices) WITH ORDINALITY AS entry(value, ordinality)
  LEFT JOIN sessions AS session ON session.session_id = binding.session_id
), '[]'::jsonb);
