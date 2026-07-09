# Accessibility (WCAG 2.2 AA) Guidelines

This document outlines the accessibility requirements and best practices for the Sovereign Migration Platform.

## WCAG 2.2 AA Compliance

Our application is committed to meeting WCAG 2.2 AA standards. This includes all requirements from WCAG 2.0, 2.1, and 2.2 at Level A and AA.

## Key Accessibility Principles

### 1. Perceivable

- **Text Alternatives**: All non-text content must have text alternatives
- **Time-Based Media**: Provide alternatives for time-based media
- **Adaptable**: Content must be adaptable to different presentations
- **Distinguishable**: Make it easier for users to see and hear content

### 2. Operable

- **Keyboard Accessible**: All functionality must be available via keyboard
- **Enough Time**: Provide users enough time to read and use content
- **Seizures and Physical Reactions**: Do not design content that causes seizures
- **Navigable**: Provide ways to help users navigate and find content
- **Input Modalities**: Make it easier to operate through various inputs

### 3. Understandable

- **Readable**: Make text readable and understandable
- **Predictable**: Make web pages appear and operate in predictable ways
- **Input Assistance**: Help users avoid and correct mistakes

### 4. Robust

- **Compatible**: Maximize compatibility with current and future user agents

## Testing

### Automated Testing

We use `@axe-core/playwright` for automated accessibility testing:

```bash
# Run accessibility tests
pnpm test:accessibility

# Run specific test file
pnpm exec playwright test tests/accessibility/wcag-compliance.spec.ts
```

### Manual Testing Checklist

- [ ] Keyboard navigation works for all interactive elements
- [ ] Focus indicators are visible
- [ ] Color contrast meets WCAG AA standards (4.5:1 for normal text, 3:1 for large text)
- [ ] Form labels are properly associated with inputs
- [ ] Error messages are announced to screen readers
- [ ] Page has proper heading hierarchy (h1 → h2 → h3)
- [ ] All images have meaningful alt text
- [ ] Interactive elements have accessible names
- [ ] Language of the page is set correctly
- [ ] Content is not lost on zoom up to 200%

## Component Guidelines

### Buttons

- Must have accessible names (textContent or aria-label)
- Disabled state must be properly indicated
- Loading states should be communicated via aria-busy

### Forms

- All inputs must have associated labels
- Error messages must be associated with inputs via aria-describedby
- Required fields must be indicated (visually and programmatically)
- Form validation errors must be announced

### Navigation

- Skip links should be provided for keyboard users
- Current page should be indicated in navigation
- Breadcrumbs should be provided for multi-level navigation

### Modals/Dialogs

- Focus must be trapped within the modal
- Escape key should close the modal
- Focus should return to the trigger element when closed
- aria-modal="true" should be set

### Color and Contrast

- Text must have a contrast ratio of at least 4.5:1 (normal text) or 3:1 (large text)
- UI components must have a contrast ratio of at least 3:1
- Color should not be the only means of conveying information

## Common Accessibility Issues to Avoid

1. **Missing alt text** on images
2. **Insufficient color contrast** between text and background
3. **Missing form labels** for inputs
4. **Improper heading hierarchy** (skipping levels)
5. **Keyboard traps** where users cannot navigate away
6. **Missing focus indicators** for keyboard navigation
7. **Using color alone** to convey information
8. **Auto-playing media** without controls
9. **Missing language attributes** on the html element
10. **Improper ARIA usage** that confuses screen readers

## Resources

- [WCAG 2.2 Guidelines](https://www.w3.org/WAI/WCAG22/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [axe-core Documentation](https://www.deque.com/axe/documentation/)
- [Web Accessibility Evaluation Tools](https://www.w3.org/WAI/test-evaluate/)

## Reporting Accessibility Issues

If you discover an accessibility issue, please report it with:
- Page URL
- Description of the issue
- Steps to reproduce
- Expected behavior
- Actual behavior
- Browser and assistive technology being used
