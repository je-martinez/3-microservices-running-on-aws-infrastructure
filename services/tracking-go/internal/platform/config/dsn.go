package config

import (
	"fmt"
	"net/url"
	"strings"
)

// MySQLDSN converts a SQLAlchemy DSN into a go-sql-driver/mysql DSN.
//
//	mysql+pymysql://user:pass@host:3306/tracking
//	  ->  user:pass@tcp(host:3306)/tracking?parseTime=true&loc=UTC
//
// The env files are generated (never hand-edited) and are shared with the Python
// service during the migration, so the SQLAlchemy spelling is what arrives and
// converting here is cheaper than forking the generator.
//
// parseTime=true and loc=UTC are ALWAYS appended, and both are load-bearing:
// without parseTime every DATETIME column comes back as []byte, and without
// loc=UTC the driver reads stored values in the process's local zone — which
// makes every timestamp wrong by the offset, silently, and only outside UTC.
func MySQLDSN(sqlAlchemyDSN string) (string, error) {
	if strings.TrimSpace(sqlAlchemyDSN) == "" {
		return "", fmt.Errorf("config: empty database DSN")
	}

	// Collapse the SQLAlchemy dialect+driver form to a plain scheme so net/url
	// parses it; "mysql+pymysql" is not a valid URL scheme character sequence
	// for every parser and carries no information we need.
	normalized := sqlAlchemyDSN
	if i := strings.Index(normalized, "://"); i >= 0 {
		normalized = "mysql" + normalized[i:]
	}

	u, err := url.Parse(normalized)
	if err != nil {
		return "", fmt.Errorf("config: unparseable database DSN: %w", err)
	}

	database := strings.TrimPrefix(u.Path, "/")
	if database == "" {
		return "", fmt.Errorf("config: database DSN names no database")
	}

	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("config: database DSN names no host")
	}
	port := u.Port()
	if port == "" {
		port = "3306"
	}

	// url.Userinfo decodes percent-escapes, which is what makes a password
	// containing @ or / survive the round trip.
	var credentials string
	if u.User != nil {
		credentials = u.User.Username()
		if password, ok := u.User.Password(); ok {
			credentials += ":" + password
		}
	}

	// Encode() sorts keys, which would put loc and parseTime in an arbitrary
	// place among any pre-existing params. Build the tail by hand so ours are
	// always last and the output is stable enough to assert on.
	existing := u.RawQuery
	tail := "parseTime=true&loc=UTC"
	if existing != "" {
		tail = existing + "&" + tail
	}

	return fmt.Sprintf("%s@tcp(%s:%s)/%s?%s", credentials, host, port, database, tail), nil
}
