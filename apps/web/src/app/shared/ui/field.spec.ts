import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Field } from './field';

describe('Field', () => {
  let fixture: ComponentFixture<Field>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({}).compileComponents();
    fixture = TestBed.createComponent(Field);
    fixture.componentRef.setInput('label', 'ZIP Code');
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders numeric fields as constrained text inputs', () => {
    fixture.componentRef.setInput('type', 'numeric');
    fixture.componentRef.setInput('autocomplete', 'postal-code');
    fixture.componentRef.setInput('maxLength', 5);
    fixture.detectChanges();

    const element = (fixture.nativeElement as HTMLElement).querySelector('input');
    expect(element?.type).toBe('text');
    expect(element?.inputMode).toBe('numeric');
    expect(element?.autocomplete).toBe('postal-code');
    expect(element?.maxLength).toBe(5);
  });

  it('strips non-digits and truncates numeric input in both the DOM and output', () => {
    const emitted: string[] = [];
    fixture.componentRef.setInput('type', 'numeric');
    fixture.componentRef.setInput('maxLength', 5);
    fixture.componentInstance.valueChange.subscribe((value) => emitted.push(value));
    fixture.detectChanges();

    const element = (fixture.nativeElement as HTMLElement).querySelector('input');
    if (!element) throw new Error('Field rendered no input');
    element.value = '10a6-04x9';
    element.dispatchEvent(new Event('input'));

    expect(element.value).toBe('10604');
    expect(emitted).toEqual(['10604']);
  });

  it('keeps the existing field types unchanged', () => {
    fixture.componentRef.setInput('type', 'email');
    fixture.detectChanges();

    const element = (fixture.nativeElement as HTMLElement).querySelector('input');
    expect(element?.type).toBe('email');
    expect(element?.hasAttribute('inputmode')).toBe(false);
  });
});
