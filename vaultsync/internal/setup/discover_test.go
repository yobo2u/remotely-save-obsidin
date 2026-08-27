package setup

import "testing"

func TestNormalizeHost(t *testing.T) {
	cases := map[string]string{
		"192.168.1.10":              "192.168.1.10",
		"https://192.168.1.10:5001": "192.168.1.10",
		"http://192.168.1.10:5000/": "192.168.1.10",
		"nas.local":                 "nas.local",
		"https://nas.local:5001":    "nas.local",
	}
	for in, want := range cases {
		if got := NormalizeHost(in); got != want {
			t.Errorf("NormalizeHost(%q)=%q want %q", in, got, want)
		}
	}
}
