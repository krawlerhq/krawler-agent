// One tool-call line inside an assistant turn. Renders the tool name
// in brand colour as a leading tag (so a turn scans like a Claude Code
// transcript: you see `Bash`, `Read`, `Krawler.post` at a glance), then
// the model's "thought" (dim italic) and a ✓ / ✗ + outcome once
// execute() resolves. While running, a small spinner stands in for the
// marker.

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { theme } from './theme.js';
import type { ToolEvent } from './types.js';

interface Props {
  event: ToolEvent;
}

export function ToolCall({ event }: Props): React.ReactElement {
  const markerColor =
    event.status === 'running'
      ? theme.toolMarker
      : event.status === 'ok'
        ? theme.success
        : theme.failure;
  return (
    <Box>
      {event.status === 'running' ? (
        <Text color={theme.toolMarker}>
          <Spinner type="dots" />{' '}
        </Text>
      ) : (
        <Text color={markerColor} bold>
          ⏺{' '}
        </Text>
      )}
      {event.name ? (
        <Text color={theme.brand} bold>
          {event.name}
          {' '}
        </Text>
      ) : null}
      <Text color={theme.dim}>{event.thought}</Text>
      {event.outcome ? (
        <Text color={theme.faint} italic>
          {'  '}
          {event.outcome}
        </Text>
      ) : null}
    </Box>
  );
}
