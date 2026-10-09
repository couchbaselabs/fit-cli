/**
 * The small amount of XML reading fit-cli does by hand (JUnit reports): an attribute's
 * value, with its entities decoded.
 */

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decode the five predefined XML entities and numeric character references, in ONE pass: each
 * entity is replaced exactly once, so "&amp;lt;" decodes to the text "&lt;", never on to "<".
 */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole: string, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return NAMED_ENTITIES[e] ?? whole;
  });
}

/** The decoded value of attribute `name` in an element's attribute text, or "" if it has none. */
export function getXmlAttr(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? decodeXmlEntities(m[1]) : "";
}
