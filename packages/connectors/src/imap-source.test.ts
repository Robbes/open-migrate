// Copyright 2026 OpenHands Agent (Apache-2.0)
// Unit tests for IMAP source connector.

import { describe, it, expect } from "vitest";
import {
  ImapSource,
  type ImapSourceConfig,
  encodeImapCursor,
  decodeImapCursor,
} from "../src/imap-source";
import type { SyncCursor } from "@openmig/shared";

describe("ImapSource", () => {
  describe("encodeImapCursor / decodeImapCursor", () => {
    it("encodes cursor correctly", () => {
      const encoded = encodeImapCursor(12345, 67890);
      expect(encoded).toBe("12345:67890");
    });

    it("decodes cursor correctly", () => {
      const cursor: SyncCursor = { value: "12345:67890" };
      const decoded = decodeImapCursor(cursor);
      expect(decoded).toEqual({ uidValidity: 12345, uidNext: 67890 });
    });

    it("throws on invalid cursor format", () => {
      const cursor: SyncCursor = { value: "invalid" };
      expect(() => decodeImapCursor(cursor)).toThrow(
        "Invalid IMAP cursor format",
      );
    });

    it("throws on non-numeric cursor values", () => {
      const cursor: SyncCursor = { value: "abc:def" };
      expect(() => decodeImapCursor(cursor)).toThrow(
        "Invalid IMAP cursor format",
      );
    });
  });

  describe("ImapSource constructor", () => {
    it("creates instance with config", () => {
      const config: ImapSourceConfig = {
        host: "imap.example.com",
        port: 993,
        tls: true,
        auth: {
          user: "test@example.com",
          password: "secret",
        },
      };
      const source = new ImapSource(config);
      expect(source).toBeInstanceOf(ImapSource);
    });

    it("creates instance with XOAUTH2 config", () => {
      const config: ImapSourceConfig = {
        host: "outlook.office365.com",
        port: 993,
        tls: true,
        auth: {
          user: "test@example.com",
          accessToken: "bearer-token",
        },
        authType: "XOAUTH2",
      };
      const source = new ImapSource(config);
      expect(source).toBeInstanceOf(ImapSource);
    });
  });
});
