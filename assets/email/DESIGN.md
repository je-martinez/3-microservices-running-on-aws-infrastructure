# 3MRAI Email Templates — Design System

## Overview

Five transactional email templates designed for the 3MRAI platform. All templates share a consistent visual language built on reusable components and a unified design token system.

Design source: `assets/email/emails.pen`

## Templates

| Template | Purpose | Icon | Accent Color |
|---|---|---|---|
| User Created | Welcome email on registration | `user-check` | Orange `#F7941D` |
| Order Created | Order confirmation with line items | `package-check` | Green `#10B981` |
| Tracking Status Update | Shipment progress with timeline | `map-pin` | Blue `#3B82F6` |
| OTP Login | One-time code for sign-in | `log-in` | Blue `#3B82F6` |
| Forgot Password | Password reset link | `key-round` | Red `#EF4444` |

## Layout Structure

Every template follows the same vertical structure at 600px width (email standard):

```
┌─────────────────────────────┐
│  Header (component)         │  Navy background, logo + wordmark
├─────────────────────────────┤
│  Body Wrapper (padding)     │
│  ┌───────────────────────┐  │
│  │  Content Card          │  │  White card, 8px radius
│  │  ┌─────────────────┐  │  │
│  │  │  Icon Circle     │  │  │  64×64, colored bg per template
│  │  │  Heading          │  │  │  24px bold
│  │  │  Greeting + Text  │  │  │  15px / 14px
│  │  │  [Template Body]  │  │  │  Varies per template
│  │  │  CTA Button       │  │  │  Centered, rounded
│  │  │  Help Text        │  │  │  12px muted, centered
│  │  └─────────────────┘  │  │
│  └───────────────────────┘  │
├─────────────────────────────┤
│  Footer (component)         │  Navy background, logo + legal
└─────────────────────────────┘
```

## Reusable Components

### Email Header
- Navy background (`#2D3748`)
- Horizontal layout: logo image (42×42, white rounded bg) + "3MRAI" wordmark + "COMPANY" tag
- Logo: `assets/img/standalone-logo.png` with white rounded container for contrast

### Email Footer
- Navy background (`#2D3748`)
- Centered: logo (32×32) + wordmark, divider, address line, legal/unsubscribe text

## Design Tokens

### Colors — Brand
| Token | Value | Usage |
|---|---|---|
| `brand-navy` | `#2D3748` | Header/footer backgrounds |
| `brand-orange` | `#F7941D` | Primary CTAs, brand accent |
| `brand-orange-light` | `#FFF4E5` | Icon circle backgrounds |

### Colors — Surfaces
| Token | Value | Usage |
|---|---|---|
| `bg-body` | `#F4F4F5` | Email body background |
| `bg-white` | `#FFFFFF` | Content cards |

### Colors — Text
| Token | Value | Usage |
|---|---|---|
| `text-primary` | `#1A1A2E` | Headings, names, key values |
| `text-secondary` | `#6B7280` | Body copy, descriptions |
| `text-muted` | `#9CA3AF` | Help text, labels, captions |

### Colors — Semantic
| Token | Value | Usage |
|---|---|---|
| `success-green` | `#10B981` | Order confirmed, completed steps |
| `success-bg` | `#ECFDF5` | Green icon circle background |
| `info-blue` | `#3B82F6` | Tracking, links, secondary CTAs |
| `info-bg` | `#EFF6FF` | Blue icon circle background |
| `border-color` | `#E5E7EB` | Dividers, card borders |

### Colors — Contextual (not tokenized)
| Value | Usage |
|---|---|
| `#EF4444` | Forgot password icon |
| `#FEE2E2` | Red icon circle background |
| `#FFF8E1` | Security warning background |
| `#F59E0B` | Warning icon |
| `#F9FAFB` | Info boxes, table backgrounds |

### Typography
| Token | Value |
|---|---|
| `font-heading` | Inter |
| `font-body` | Inter |

### Type Scale
| Element | Size | Weight |
|---|---|---|
| Heading | 24px | 700 |
| Greeting | 15px | 400 |
| Body text | 14px | 400 |
| Key-value labels | 13px | 400 / 500 |
| Section titles | 13–14px | 600 |
| Help/legal text | 11–12px | 400 |
| CTA buttons | 15px | 600 |
| OTP digits | 28px | 700 |

## Iconography

All icons use the **Lucide** icon library.

| Template | Icons Used |
|---|---|
| User Created | `user-check` |
| Order Created | `package-check`, `package-search` |
| Tracking Status Update | `map-pin`, `check`, `external-link` |
| OTP Login | `log-in`, `triangle-alert` |
| Forgot Password | `key-round`, `lock`, `timer`, `triangle-alert` |

## Component Patterns

### Icon Circle
64×64 frame, full border-radius (32px), colored background matching the template's semantic color. Contains a 28×28 Lucide icon.

### CTA Button
Horizontal frame with 14px vertical / 40px horizontal padding, 6px border-radius, filled with accent color. Contains optional 16×16 icon + 15px bold white text.

### Key-Value Row
Horizontal frame, `space_between` justification. Left: 13px secondary text (label). Right: 13px medium-weight primary text (value).

### Security Notice
Horizontal frame with `#FFF8E1` background, 8px radius, 14px padding. Contains `triangle-alert` warning icon + vertical text block (13px bold title + 12px body).

### Tracking Timeline
Vertical stack of step rows. Each row: indicator column (done=green circle with check, active=orange ring, pending=empty bordered circle) connected by 2px vertical lines + text column (label + date).

### OTP Code Display
Horizontal row of 6 individual digit cells. Each cell: 48×48 frame, `#F9FAFB` fill, 1px `border-color` stroke, 8px radius. Contains centered 28px bold digit.

## Assets

| File | Path | Usage |
|---|---|---|
| Logo (standalone cube) | `assets/img/standalone-logo.png` | Header & footer logo |
| Logo (full with text) | `assets/img/logo.png` | Available but not used in templates |
