resource "google_compute_security_policy" "example" {
  name        = "kinglet-validation-policy"
  description = "Cloud Armor evaluation fixture: path, IP, header, query, method, preview, redirect, throttle, default allow"

  # 100 — path prefix deny
  rule {
    action      = "deny(403)"
    priority    = 100
    description = "Block /admin"

    match {
      expr {
        expression = "request.path.startsWith('/admin')"
      }
    }
  }

  # 200 — path equality as deny(404)
  rule {
    action      = "deny(404)"
    priority    = 200
    description = "Hide /hidden"

    match {
      expr {
        expression = "request.path == '/hidden'"
      }
    }
  }

  # 300 — header-phase redirect
  rule {
    action      = "redirect"
    priority    = 300
    description = "Redirect retired login path"

    match {
      expr {
        expression = "request.path.startsWith('/login-old')"
      }
    }

    redirect_options {
      type   = "EXTERNAL_302"
      target = "https://example.com/login"
    }
  }

  # 400 — method + path
  rule {
    action      = "deny(403)"
    priority    = 400
    description = "Reject PUT under /api"

    match {
      expr {
        expression = "request.method == 'PUT' && request.path.startsWith('/api')"
      }
    }
  }

  # 500 — blocked source range
  rule {
    action      = "deny(403)"
    priority    = 500
    description = "Deny TEST-NET-2 (198.51.100.0/24)"

    match {
      expr {
        expression = "inIpRange(origin.ip, '198.51.100.0/24')"
      }
    }
  }

  # 600 — office allow for /internal (must sit above the /internal deny)
  rule {
    action      = "allow"
    priority    = 600
    description = "Allow TEST-NET-1 office net on /internal"

    match {
      expr {
        expression = "inIpRange(origin.ip, '192.0.2.0/24') && request.path.startsWith('/internal')"
      }
    }
  }

  # 700 — everyone else off /internal
  rule {
    action      = "deny(403)"
    priority    = 700
    description = "Deny /internal by default"

    match {
      expr {
        expression = "request.path.startsWith('/internal')"
      }
    }
  }

  # 800 — User-Agent
  rule {
    action      = "deny(403)"
    priority    = 800
    description = "Block BadBot"

    match {
      expr {
        expression = "request.headers['user-agent'].contains('BadBot')"
      }
    }
  }

  # 900 — raw query string
  rule {
    action      = "deny(403)"
    priority    = 900
    description = "Block debug query flag"

    match {
      expr {
        expression = "request.query.contains('debug=1')"
      }
    }
  }

  # 1000 — Host
  rule {
    action      = "deny(403)"
    priority    = 1000
    description = "Block unexpected Host"

    match {
      expr {
        expression = "request.headers['host'] == 'evil.example.com'"
      }
    }
  }

  # 1100 — RE2 path match
  rule {
    action      = "deny(403)"
    priority    = 1100
    description = "Block /secret/*"

    match {
      expr {
        expression = "request.path.matches('^/secret/')"
      }
    }
  }

  # 1200 — preview (logs would-be deny, does not enforce)
  rule {
    action      = "deny(403)"
    priority    = 1200
    preview     = true
    description = "Preview deny on /preview-me"

    match {
      expr {
        expression = "request.path.startsWith('/preview-me')"
      }
    }
  }

  # 1300 — exact in-process throttle (count 1 → second request 429)
  rule {
    action      = "throttle"
    priority    = 1300
    description = "Throttle /limited to 1 request per 60s per IP"

    match {
      expr {
        expression = "request.path.startsWith('/limited')"
      }
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {
        count        = 1
        interval_sec = 60
      }
    }
  }

  # 1400 — deny(502)
  rule {
    action      = "deny(502)"
    priority    = 1400
    description = "Synthetic upstream deny"

    match {
      expr {
        expression = "request.path.startsWith('/upstream-down')"
      }
    }
  }

  # Default rule — required if you care about its action (API inserts allow when omitted)
  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default allow"

    match {
      versioned_expr = "SRC_IPS_V1"

      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}
