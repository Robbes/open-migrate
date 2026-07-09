import { render } from '@testing-library/react';
import { Button } from '@/components/ui/button';

describe('Button Accessibility', () => {
  test('should have proper role for default button', () => {
    const { container } = render(<Button>Click me</Button>);
    const button = container.querySelector('button');
    
    expect(button).toBeInTheDocument();
    expect(button?.getAttribute('role')).toBeNull(); // button element has implicit role="button"
  });

  test('should have proper role when asChild is used', () => {
    const { container } = render(
      <Button asChild>
        <a href="/link">Link button</a>
      </Button>
    );
    const link = container.querySelector('a');
    
    expect(link).toBeInTheDocument();
    expect(link?.getAttribute('role')).toBeNull(); // anchor has implicit role="link"
  });

  test('should support aria-label', () => {
    const { container } = render(
      <Button aria-label="Close dialog">X</Button>
    );
    const button = container.querySelector('button');
    
    expect(button?.getAttribute('aria-label')).toBe('Close dialog');
  });

  test('should support aria-describedby', () => {
    const { container } = render(
      <Button aria-describedby="help-text">Click me</Button>
    );
    const button = container.querySelector('button');
    
    expect(button?.getAttribute('aria-describedby')).toBe('help-text');
  });

  test('should have disabled state when disabled prop is set', () => {
    const { container } = render(<Button disabled>Disabled</Button>);
    const button = container.querySelector('button');
    
    expect(button?.getAttribute('disabled')).toBe('');
  });

  test('should support aria-expanded for dropdown buttons', () => {
    const { container } = render(
      <Button aria-expanded="true">Dropdown</Button>
    );
    const button = container.querySelector('button');
    
    expect(button?.getAttribute('aria-expanded')).toBe('true');
  });
});
