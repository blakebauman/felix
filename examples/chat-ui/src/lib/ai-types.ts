// Minimal AI-SDK-shaped UI types the ported prompt-input engine references.
// Felix has its own wire model (see src/types.ts); these only describe the
// in-browser composer state (the file parts a PromptInput collects).

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export type FileUIPart = {
  type: "file";
  mediaType: string;
  filename?: string;
  url: string;
  data?: string;
};

export type SourceDocumentUIPart = {
  type: "source-document";
  sourceId: string;
  title?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
};
