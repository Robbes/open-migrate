// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

// Vitest setup for web component tests: registers @testing-library/jest-dom
// matchers (toBeInTheDocument, etc.) and clears the DOM between tests.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
