export interface ExtractedResource {
  original_uri: string;
  content_type: string;
  raw_base64: string;
}

const DATA_URI_REGEX = /data:([^;]+);base64,([A-Za-z0-9+/=.]+)/g;

export function extractDataUris(html: string): ExtractedResource[] {
  const seen = new Set<string>();
  const resources: ExtractedResource[] = [];

  for (const match of html.matchAll(DATA_URI_REGEX)) {
    const fullUri = match[0];
    if (seen.has(fullUri)) continue;
    seen.add(fullUri);

    resources.push({
      original_uri: fullUri,
      content_type: match[1],
      raw_base64: match[2],
    });
  }

  return resources;
}
