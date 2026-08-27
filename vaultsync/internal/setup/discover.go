package setup

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Device struct {
	IP          string `json:"ip"`
	Name        string `json:"name"`
	HTTPPort    int    `json:"httpPort"`
	HTTPSPort   int    `json:"httpsPort"`
	WebDAVHTTP  int    `json:"webdavHttp"`
	WebDAVHTTPS int    `json:"webdavHttps"`
}

func localNets() []*net.IPNet {
	var nets []*net.IPNet
	ifs, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, iface := range ifs {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil {
				continue
			}
			ip := ipn.IP.To4()
			if ip[0] == 10 || (ip[0] == 192 && ip[1] == 168) || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) {
				ones, bits := ipn.Mask.Size()
				if bits == 32 && ones >= 24 {
					nets = append(nets, ipn)
				}
			}
		}
	}
	return nets
}

func hostsInNet(n *net.IPNet) []string {
	ip := n.IP.To4()
	mask := net.IP(n.Mask).To4()
	var hosts []string
	// Only scan /24 of the interface address to stay local and fast.
	base := []byte{ip[0], ip[1], ip[2], 0}
	_ = mask
	for i := 1; i < 255; i++ {
		if int(ip[3]) == i {
			continue
		}
		hosts = append(hosts, fmt.Sprintf("%d.%d.%d.%d", base[0], base[1], base[2], i))
	}
	return hosts
}

func DiscoverSynology(ctx context.Context, timeout time.Duration) ([]Device, error) {
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	nets := localNets()
	if len(nets) == 0 {
		return nil, fmt.Errorf("no private IPv4 interface found")
	}
	seen := map[string]Device{}
	var mu sync.Mutex
	sem := make(chan struct{}, 64)
	var wg sync.WaitGroup
	client := &http.Client{
		Timeout: 900 * time.Millisecond,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		},
	}
	probe := func(ip string) {
		defer wg.Done()
		sem <- struct{}{}
		defer func() { <-sem }()
		dev, ok := probeDSM(ctx, client, ip)
		if !ok {
			return
		}
		mu.Lock()
		seen[dev.IP] = dev
		mu.Unlock()
	}
	for _, n := range nets {
		for _, h := range hostsInNet(n) {
			if ctx.Err() != nil {
				break
			}
			wg.Add(1)
			go probe(h)
		}
	}
	wg.Wait()
	out := make([]Device, 0, len(seen))
	for _, d := range seen {
		out = append(out, d)
	}
	return out, nil
}

func probeDSM(ctx context.Context, client *http.Client, ip string) (Device, bool) {
	u := fmt.Sprintf("http://%s:5000/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth", ip)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return Device{}, false
	}
	rsp, err := client.Do(req)
	if err != nil {
		return Device{}, false
	}
	defer rsp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(rsp.Body, 4096))
	if rsp.StatusCode >= 400 {
		return Device{}, false
	}
	var parsed struct {
		Success bool `json:"success"`
	}
	if json.Unmarshal(b, &parsed) != nil || !parsed.Success {
		if !strings.Contains(string(b), "SYNO.API") {
			return Device{}, false
		}
	}
	dev := Device{IP: ip, HTTPPort: 5000, HTTPSPort: 5001, Name: ip}
	if webdavOpen(ctx, client, fmt.Sprintf("https://%s:5006/", ip)) {
		dev.WebDAVHTTPS = 5006
	}
	if webdavOpen(ctx, client, fmt.Sprintf("http://%s:5005/", ip)) {
		dev.WebDAVHTTP = 5005
	}
	return dev, true
}

func webdavOpen(ctx context.Context, client *http.Client, addr string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodOptions, addr, nil)
	if err != nil {
		return false
	}
	rsp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer rsp.Body.Close()
	return rsp.StatusCode < 500
}

func NormalizeHost(host string) string {
	host = strings.TrimSpace(host)
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimSuffix(host, "/")
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

func ProbeHost(ctx context.Context, host string) (Device, bool) {
	client := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		},
	}
	host = NormalizeHost(host)
	if host == "" {
		return Device{}, false
	}
	return probeDSM(ctx, client, host)
}
