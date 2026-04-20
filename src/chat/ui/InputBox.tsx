// Bordered multi-line input box. This is the component the human
// stares at; matches the Claude-Code feel (rounded border, "> "
// prompt, single-line-ish but growing on wrap). Input events come
// from Ink's useInput hook — we manage cursor + buffer ourselves
// because ink-text-input doesn't play well with overlays or multi-
// line.

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { SLASH_COMMANDS } from './slash.js';
import type { SlashCommand } from './SlashPopover.js';
import { theme } from './theme.js';

export interface Mentionable {
  handle: string;
  displayName: string | null;
}

interface Props {
  disabled: boolean;
  onSubmit: (value: string) => void;
  placeholder?: string;
  onSuggestionsChange?: (matches: SlashCommand[], selected: number) => void;
  // Other agents the user can address via `@<handle>`. When the buffer
  // starts with `@`, these feed the popover instead of the slash list.
  mentionables?: Mentionable[];
}

export function InputBox({ disabled, onSubmit, placeholder, onSuggestionsChange, mentionables }: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);

  // Slash and mention autocomplete share the popover slot. Slash takes
  // priority when both would match (a buffer of just "/" or "@" only
  // hits one anyway since the prefixes are distinct).
  const matches = useMemo<SlashCommand[]>(() => {
    if (value.startsWith('/')) {
      const q = value.slice(1).toLowerCase();
      return SLASH_COMMANDS.filter((c) =>
        c.name.slice(1).toLowerCase().startsWith(q),
      );
    }
    if (value.startsWith('@') && mentionables && mentionables.length > 0) {
      // Only show the popover while the user is still typing the handle.
      // Once they hit space the routing intent is locked in and further
      // suggestions would just be noise.
      if (value.includes(' ')) return [];
      const q = value.slice(1).toLowerCase();
      return mentionables
        .filter((m) => m.handle.toLowerCase().startsWith(q))
        .map<SlashCommand>((m) => ({
          name: `@${m.handle}`,
          hint: m.displayName ?? '',
        }));
    }
    return [];
  }, [value, mentionables]);

  useEffect(() => {
    if (selected >= matches.length) setSelected(0);
  }, [matches, selected]);

  useEffect(() => {
    onSuggestionsChange?.(matches, selected);
  }, [matches, selected, onSuggestionsChange]);

  useInput(
    (input, key) => {
      if (disabled) return;
      // When a chunk of raw input arrives with an embedded newline
      // (expect-style buffered sends, pasted multi-line text), the
      // default keypress parse misses the Enter. Detect that case
      // and split: everything before the newline goes into the
      // buffer, then submit. This also makes real-terminal pastes
      // work without surprises.
      if (!key.return && (input.includes('\n') || input.includes('\r'))) {
        const split = input.split(/[\r\n]/);
        const head = split[0] ?? '';
        const rest = split.slice(1).join('');
        const combined = value.slice(0, cursor) + head + value.slice(cursor);
        setValue('');
        setCursor(0);
        onSubmit(combined);
        // Any text after the newline becomes the next line of input;
        // stash it so the user sees it instead of losing it.
        if (rest) setValue(rest);
        return;
      }
      if (key.return) {
        const out = value;
        setValue('');
        setCursor(0);
        onSubmit(out);
        return;
      }
      if (key.tab && matches.length > 0) {
        const pick = matches[selected];
        if (pick) {
          setValue(pick.name + ' ');
          setCursor(pick.name.length + 1);
        }
        return;
      }
      if (key.upArrow && matches.length > 0) {
        setSelected((s) => (s - 1 + matches.length) % matches.length);
        return;
      }
      if (key.downArrow && matches.length > 0) {
        setSelected((s) => (s + 1) % matches.length);
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.ctrl && input === 'u') {
        setValue('');
        setCursor(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive: true },
  );

  const shown = value;
  const hasCursor = cursor <= shown.length;
  const before = shown.slice(0, cursor);
  const at = shown.slice(cursor, cursor + 1) || ' ';
  const after = shown.slice(cursor + 1);

  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? theme.muted : theme.brand}
      paddingX={1}
      width="100%"
    >
      <Text color={disabled ? theme.muted : theme.brand} bold>
        {'> '}
      </Text>
      {value.length === 0 ? (
        <Text color={theme.dim}>{placeholder ?? 'message…'}</Text>
      ) : (
        <>
          <Text>{before}</Text>
          {hasCursor ? <Text inverse>{at}</Text> : null}
          <Text>{after}</Text>
        </>
      )}
    </Box>
  );
}
