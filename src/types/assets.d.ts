declare module "*.yaml" {
  const content: unknown;
  export default content;
}

declare module "*.yml" {
  const content: unknown;
  export default content;
}

declare module "*.json5" {
  const content: unknown;
  export default content;
}

declare module "*.html" {
  const content: string;
  export default content;
}
