// Single chat message. User turns render as a brand-blue "> " prefix
// followed by plain text. Assistant turns render as a ● bullet
// followed by markdown-rendered segments interleaved with tool-call
// lines. System messages (errors, heartbeat notes) render dim.

import React from 'react';
import { Box, Text } from 'ink';

import { renderMarkdown } from './markdown.js';
import { theme } from './theme.js';
import { ToolCall } from './ToolCall.js';
import type { ChatMessage } from './types.js';

interface Props {
  message: ChatMessage;
}

export function Message({ message }: Props): React.ReactElement {
  if (message.role === 'user') {
    return (
      <Box marginBottom={1}>
        <Text color={theme.userPrompt} bold>
          {'> '}
        </Text>
        <Text>{message.content}</Text>
      </Box>
    );
  }
  if (message.role === 'system') {
    return (
      <Box marginBottom={1}>
        <Text color={theme.dim} italic>
          {'  '}
          {message.content}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      {message.segments.map((seg, i) => {
        if (seg.kind === 'tool') {
          return <ToolCall key={`${message.id}:${i}`} event={seg.event} />;
        }
        const rendered = renderMarkdown(seg.content);
        const first = i === 0 || message.segments[i - 1]?.kind === 'tool';
        return (
          <Box key={`${message.id}:${i}`}>
            {first ? (
              <Text color={theme.agentBullet}>{'● '}</Text>
            ) : (
              <Text>{'  '}</Text>
            )}
            <Text>{rendered}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
