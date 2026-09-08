package openapi

import (
	"fmt"
	"sort"
	"strings"
)

// Difference is one place the generated document and the pinned contract
// disagree. Path is a dotted location, not a JSON pointer: the segments it names
// contain "/" a pointer would escape, and this string exists to be greppable in
// a test failure.
type Difference struct {
	Path string
	Got  any
	Want any
}

// AllowedDifference is one enumerated, justified exception. Path supports a
// trailing "*" matching a single segment.
//
// CONTRACT: Do NOT widen this to a general glob. A pattern that swallows a
// subtree hides a real divergence, and this list exists to be inspectable.
type AllowedDifference struct {
	Path          string
	Justification string
}

// Diff walks both documents and returns every difference NOT covered by
// AllowedDifferences.
//
// CONTRACT: Report BOTH directions. A key the contract declares and the code
// omits loses a client a documented failure; the reverse adds one. Absence on
// either side is a Difference with a nil on that side.
func Diff(got, want map[string]any) []Difference {
	var diffs []Difference
	walk("", normalize(got), normalize(want), &diffs)

	kept := diffs[:0]
	for _, d := range diffs {
		if !allowed(d.Path) {
			kept = append(kept, d)
		}
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].Path < kept[j].Path })
	return kept
}

func allowed(path string) bool {
	for _, a := range AllowedDifferences {
		if matches(a.Path, path) {
			return true
		}
	}
	return false
}

// matches reports whether a pattern covers a concrete path. A "*" segment matches
// exactly one segment; a pattern also covers everything BELOW the path it names,
// since a difference at "…schema" and one at "…schema.$ref" are the same fact
// seen at two depths.
func matches(pattern, path string) bool {
	p := strings.Split(pattern, ".")
	c := strings.Split(path, ".")
	if len(c) < len(p) {
		return false
	}
	for i, seg := range p {
		if seg == "*" {
			continue
		}
		if c[i] != seg {
			return false
		}
	}
	return true
}

func walk(path string, got, want any, out *[]Difference) {
	switch wantVal := want.(type) {
	case map[string]any:
		gotVal, ok := got.(map[string]any)
		if !ok {
			*out = append(*out, Difference{Path: path, Got: got, Want: want})
			return
		}
		for _, key := range unionKeys(gotVal, wantVal) {
			g, gOK := gotVal[key]
			w, wOK := wantVal[key]
			child := join(path, key)
			switch {
			case !gOK:
				*out = append(*out, Difference{Path: child, Got: nil, Want: w})
			case !wOK:
				*out = append(*out, Difference{Path: child, Got: g, Want: nil})
			default:
				walk(child, g, w, out)
			}
		}
	case []any:
		gotVal, ok := got.([]any)
		if !ok || len(gotVal) != len(wantVal) {
			*out = append(*out, Difference{Path: path, Got: got, Want: want})
			return
		}
		for i := range wantVal {
			walk(fmt.Sprintf("%s[%d]", path, i), gotVal[i], wantVal[i], out)
		}
	default:
		if fmt.Sprint(got) != fmt.Sprint(want) {
			*out = append(*out, Difference{Path: path, Got: got, Want: want})
		}
	}
}

func unionKeys(a, b map[string]any) []string {
	seen := make(map[string]struct{}, len(a)+len(b))
	keys := make([]string, 0, len(a)+len(b))
	for _, m := range []map[string]any{a, b} {
		for k := range m {
			if _, dup := seen[k]; dup {
				continue
			}
			seen[k] = struct{}{}
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// normalize makes two trees from different serializers comparable: map keys
// become strings, and numbers collapse to one textual form.
//
// CONTRACT: Do NOT normalize anything else. Reordering a list or dropping a key
// makes the diff lie — `required` ordering is an ALLOWLIST entry precisely
// because normalizing it away would hide a genuinely changed required set.
func normalize(v any) any {
	switch value := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(value))
		for k, item := range value {
			out[k] = normalize(item)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(value))
		for k, item := range value {
			out[fmt.Sprint(k)] = normalize(item)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = normalize(item)
		}
		return out
	case uint64:
		return fmt.Sprint(value)
	case int64:
		return fmt.Sprint(value)
	case int:
		return fmt.Sprint(value)
	case float64:
		return fmt.Sprint(value)
	default:
		return v
	}
}
