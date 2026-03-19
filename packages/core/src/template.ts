// ============================================================
// @dagflow/core — Template Engine for Data Passing
// ============================================================

/**
 * Resolve template strings like "{{nodeId.output}}" or "{{nodeId.output.field}}"
 * against a context of node outputs.
 */
export function resolveTemplate(
  template: string,
  context: Record<string, unknown>,
  variables?: Record<string, unknown>
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim();

    // Handle global variables: {{$var.name}} or {{$name}}
    if (trimmed.startsWith('$')) {
      const varPath = trimmed.slice(1); // remove leading $
      // Support both {{$var.name}} and {{$name}} shorthand
      const actualPath = varPath.startsWith('var.') ? varPath.slice(4) : varPath;
      if (variables) {
        const value = resolvePath({ ...variables } as Record<string, unknown>, actualPath);
        if (value !== undefined) {
          return typeof value === 'string' ? value : JSON.stringify(value);
        }
      }
      return `{{${trimmed}}}`;
    }

    const value = resolvePath(context, trimmed);
    if (value === undefined) return `{{${trimmed}}}`;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

/**
 * Resolve a dotted path like "nodeA.output.field" against nested objects.
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Assemble input for a node based on its inputTemplate and upstream outputs.
 * If no template, just merge all upstream outputs.
 */
export function assembleNodeInput(
  inputTemplate: string | undefined,
  upstreamOutputs: Record<string, unknown>,
  edgeTransforms?: Record<string, string>,
  variables?: Record<string, unknown>
): unknown {
  // Apply edge transforms first (simplified: just path extraction for now)
  const transformed: Record<string, unknown> = {};
  for (const [nodeId, output] of Object.entries(upstreamOutputs)) {
    const transform = edgeTransforms?.[nodeId];
    if (transform) {
      // Simple dot-path transform
      transformed[nodeId] = resolvePath(
        { output } as Record<string, unknown>,
        transform
      ) ?? output;
    } else {
      transformed[nodeId] = output;
    }
  }

  if (inputTemplate) {
    // Build context for template resolution
    const context: Record<string, unknown> = {};
    for (const [nodeId, output] of Object.entries(transformed)) {
      context[nodeId] = { output };
    }
    return resolveTemplate(inputTemplate, context, variables);
  }

  // No template: if single upstream, pass its output directly
  const keys = Object.keys(transformed);
  if (keys.length === 1) {
    return transformed[keys[0]];
  }

  // Multiple upstreams: return map
  return transformed;
}
