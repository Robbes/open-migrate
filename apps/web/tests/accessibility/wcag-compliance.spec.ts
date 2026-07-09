import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('WCAG 2.2 AA Compliance - Home Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/en');
  });

  test('should pass all WCAG 2.2 AA criteria', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should have proper landmark regions', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['landmark'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should have proper heading hierarchy', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['heading'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should have proper color contrast', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['color-contrast'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });
});

test.describe('WCAG 2.2 AA Compliance - Login Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/en/login');
  });

  test('should pass all WCAG 2.2 AA criteria', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should have accessible form labels', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['label'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should have proper button accessibility', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['button'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });
});

test.describe('WCAG 2.2 AA Compliance - Dashboard Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/en/dashboard');
  });

  test('should pass all WCAG 2.2 AA criteria', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should have proper table accessibility', async ({ page }) => {
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['table'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });
});
