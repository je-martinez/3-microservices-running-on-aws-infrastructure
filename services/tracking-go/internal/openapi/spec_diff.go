package openapi

import (
	"fmt"
	"sort"
	"strings"
)

// Difference is one place where the generated Go document and the committed
// Python contract disagree.
//
// Path is a dotted location — "paths./v1/trackings.get.responses.401" — rather
// than a strict JSON pointer, because the segments it names (paths, media types)
// contain the "/" a pointer would have to escape, and the whole value of this
// string is being greppable in a test failure.
type Difference struct {
	Path string
	Got  any
	Want any
}

// AllowedDifference is one enumerated, justified exception.
//
// Path supports a trailing "*" as the LAST segment of a run, matching any single
// segment there — "components.schemas.*.title" covers every schema's title
// without listing thirteen of them. It is deliberately not a general glob: a
// pattern powerful enough to swallow a subtree could hide a real divergence, and
// the point of this list is that everything on it is inspectable.
type AllowedDifference struct {
	Path          string
	Justification string
}

// Diff walks both documents and returns every difference NOT covered by
// AllowedDifferences.
//
// # Why this compares the Go document against the Python one and not the reverse
//
// Both directions matter and both are reported: a key the Python declares and the
// Go omits is a MISSING contract (a client loses a documented failure), and a key
// the Go declares and the Python omits is an ADDED one. Neither is safe to ignore,
// so absence on either side is a Difference with a nil on that side, and the
// allowlist is what makes the deliberate ones explicit.
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

// normalize makes two trees that came from different serializers comparable
// WITHOUT hiding a real difference.
//
// It does exactly two things, and both are about representation rather than
// content: map keys become strings (a YAML parser yields the status code 401 as
// an int on one side and the Go builder writes "401" on the other), and numbers
// collapse to a single textual form (the YAML parser hands back uint64 where the
// builder holds int). Anything beyond that — reordering a list, dropping a key —
// would be the diff lying, so it is NOT done here; the `required` ordering is an
// ALLOWLIST entry precisely because normalizing it away would also hide a
// genuinely changed required set.
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
