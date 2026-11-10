resource "google_sql_database_instance" "app" {
  name                = "kinglet-validation-sql"
  database_version    = "POSTGRES_15"
  region              = var.region
  deletion_protection = false

  settings {
    tier = "db-f1-micro"

    database_flags {
      name  = "cloudsql.enable_pg_stat_statements"
      value = "on"
    }
  }
}
