resource "google_compute_security_policy" "address_group" {
  name        = "kinglet-validation-address-group-policy"
  description = "evaluateAddressGroup against google_network_security_address_group.cloud_armor"

  depends_on = [google_network_security_address_group.cloud_armor]

  rule {
    action      = "deny(403)"
    priority    = 500
    description = "Address group hit excluding 198.51.100.20"

    match {
      expr {
        expression = "evaluateAddressGroup('kinglet-validation-web-allow', origin.ip, ['198.51.100.20'])"
      }
    }
  }

  rule {
    action      = "deny(403)"
    priority    = 1000
    description = "Address group hit"

    match {
      expr {
        expression = "evaluateAddressGroup('kinglet-validation-web-allow', origin.ip)"
      }
    }
  }

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
