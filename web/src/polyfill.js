// Some wallet modules expect Node's Buffer to exist. Load this before anything from the selector.
import { Buffer } from 'buffer';

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
