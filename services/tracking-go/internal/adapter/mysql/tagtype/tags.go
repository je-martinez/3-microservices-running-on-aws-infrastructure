package tagtype

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
)

// Tags is the Go representation of tracking.tags, a MySQL JSON array of strings.
//
// MySQL has no array type, so the portable equivalent of Users' Postgres text[]
// is a JSON array, queried with JSON_CONTAINS. This type is referenced by an
// override in sqlc.yaml so the generated model exposes []string rather than
// json.RawMessage, keeping marshalling out of every call site.
type Tags []string

// Value marshals the tags to a JSON array.
//
// A nil or empty Tags marshals to `[]`, NEVER to NULL. The column is NOT NULL
// with a DEFAULT (JSON_ARRAY()), and a NULL would give "no tags" two spellings —
// worse, JSON_CONTAINS(NULL, ...) evaluates to NULL rather than FALSE, so a NULL
// row is silently excluded from the e2e-cleanup predicate for a reason that
// reads like an accident.
func (t Tags) Value() (driver.Value, error) {
	if t == nil {
		return []byte("[]"), nil
	}
	b, err := json.Marshal([]string(t))
	if err != nil {
		return nil, fmt.Errorf("marshal tags: %w", err)
	}
	return b, nil
}

// Scan unmarshals a JSON array from the driver.
//
// Accepts []byte and string (drivers differ), and degrades a nil source to an
// empty slice rather than panicking: the column is NOT NULL today, but a row
// written before that constraint existed must not crash a read path.
func (t *Tags) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*t = Tags{}
		return nil
	case []byte:
		return t.unmarshal(v)
	case string:
		return t.unmarshal([]byte(v))
	default:
		return fmt.Errorf("cannot scan %T into Tags", src)
	}
}

func (t *Tags) unmarshal(b []byte) error {
	if len(b) == 0 {
		*t = Tags{}
		return nil
	}
	var out []string
	if err := json.Unmarshal(b, &out); err != nil {
		return fmt.Errorf("unmarshal tags: %w", err)
	}
	if out == nil {
		out = []string{}
	}
	*t = Tags(out)
	return nil
}
