/**
 * Extract meaningful text from various content formats for embedding generation
 */
export function extractTextForEmbedding(content: unknown, tags?: string[], type?: string): string {
  const textParts: string[] = [];

  // Extract the most important text from content
  const extractedText = extractKeyTermsFromValue(content);
  if (extractedText) {
    textParts.push(extractedText);
  }

  // Add type for context
  if (type) {
    textParts.push(type);
  }

  // Tags can be included but shouldn't dominate
  // They're better used for filtering than semantic search
  if (tags && tags.length > 0) {
    textParts.push(tags.join(' '));
  }

  // Join with spaces and clean up
  return textParts
    .join(' ')
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

/**
 * Extract only key terms from content (titles, names, etc)
 */
function extractKeyTermsFromValue(value: unknown, maxDepth = 3): string {
  if (maxDepth <= 0) return '';

  const texts: string[] = [];

  if (typeof value === 'string') {
    // Only include if it's short and likely a key term
    if (value.length < 100) {
      texts.push(value);
    }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Expanded priority keys to capture more relevant content
    const priorityKeys = [
      'title',
      'name',
      'description',
      'summary',
      'text',
      'message',
      'content',
      'value',
      'result',
      'pattern',
      'implementation',
      'query',
      'answer',
      'insight',
      'decision',
      'preference',
      'task',
      'action',
      'error',
      'status',
      'type',
    ];
    const obj = value as Record<string, unknown>;

    for (const key of priorityKeys) {
      if (key in obj) {
        const val = obj[key];
        if (typeof val === 'string' && val.length < 200) {
          texts.push(val);
        } else if (val && typeof val === 'object') {
          // Recursively extract from nested objects
          const nested = extractKeyTermsFromValue(val, maxDepth - 1);
          if (nested) texts.push(nested);
        }
      }
    }
  } else if (Array.isArray(value)) {
    // Process first few array items
    for (let i = 0; i < Math.min(3, value.length); i++) {
      const text = extractKeyTermsFromValue(value[i], maxDepth - 1);
      if (text) texts.push(text);
    }
  }

  return texts
    .filter((t) => t && t.length > 0)
    .join(' ')
    .replace(/[{}[\]"]/g, '') // Remove JSON structure characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}
