package config_test

import (
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config"
)

func TestMySQLDSN(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{
			name: "sqlalchemy pymysql dsn",
			in:   "mysql+pymysql://root:secret@floci-mysql:3306/tracking",
			want: "root:secret@tcp(floci-mysql:3306)/tracking?parseTime=true&loc=UTC",
		},
		{
			name: "bare mysql scheme",
			in:   "mysql://root:secret@127.0.0.1:7001/tracking",
			want: "root:secret@tcp(127.0.0.1:7001)/tracking?parseTime=true&loc=UTC",
		},
		{
			name: "no port defaults to 3306",
			in:   "mysql+pymysql://root:secret@db/tracking",
			want: "root:secret@tcp(db:3306)/tracking?parseTime=true&loc=UTC",
		},
		{
			name: "password with url-encoded characters is decoded",
			in:   "mysql+pymysql://root:p%40ss%2Fword@db:3306/tracking",
			want: "root:p@ss/word@tcp(db:3306)/tracking?parseTime=true&loc=UTC",
		},
		{
			name: "existing query params are preserved and ours appended",
			in:   "mysql+pymysql://root:secret@db:3306/tracking?charset=utf8mb4",
			want: "root:secret@tcp(db:3306)/tracking?charset=utf8mb4&parseTime=true&loc=UTC",
		},
		{
			name: "no user or password",
			in:   "mysql+pymysql://db:3306/tracking",
			want: "@tcp(db:3306)/tracking?parseTime=true&loc=UTC",
		},
		{name: "empty is an error", in: "", wantErr: true},
		{name: "no database name is an error", in: "mysql+pymysql://root:secret@db:3306", wantErr: true},
		{name: "unparseable is an error", in: "://://", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := config.MySQLDSN(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("MySQLDSN(%q) = %q, want error", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("MySQLDSN(%q) returned unexpected error: %v", tt.in, err)
			}
			if got != tt.want {
				t.Errorf("MySQLDSN(%q)\n got = %q\nwant = %q", tt.in, got, tt.want)
			}
		})
	}
}

// parseTime and loc are what make DATETIME columns arrive as time.Time in UTC.
// Asserted separately from the table so a future change to the table cannot
// quietly drop them from every case at once.
func TestMySQLDSNAlwaysAppendsParseTimeAndUTC(t *testing.T) {
	inputs := []string{
		"mysql+pymysql://root:secret@db:3306/tracking",
		"mysql+pymysql://root:secret@db:3306/tracking?charset=utf8mb4",
		"mysql://a:b@h/d",
	}
	for _, in := range inputs {
		got, err := config.MySQLDSN(in)
		if err != nil {
			t.Fatalf("MySQLDSN(%q): %v", in, err)
		}
		if !strings.Contains(got, "parseTime=true") {
			t.Errorf("MySQLDSN(%q) = %q, missing parseTime=true", in, got)
		}
		if !strings.Contains(got, "loc=UTC") {
			t.Errorf("MySQLDSN(%q) = %q, missing loc=UTC", in, got)
		}
	}
}
