/**
 * A plugin's or a solution's file picked for Install from a file: its bytes and what is in it, read in the
 * main process (signatures checked against the product's publishers) before the window asks to install it.
 */
export interface PickedPlugin {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  /** verified: every file as an official publisher signed it; changed: signed, but its files differ; signed: by a key this app does not know. */
  signature: 'verified' | 'changed' | 'signed' | 'unsigned';
  signedBy?: string;
}

export interface PickedBundle {
  file: string;
  base64: string;
  kind: 'plugin' | 'solution';
  title: string;
  version: string;
  description?: string;
  publisher?: string;
  license?: string;
  /** The core versions it runs on. */
  harness?: string;
  plugins: PickedPlugin[];
}
