package com.gauthamchandra.secretmanager.resource;

import static io.restassured.RestAssured.given;
import static org.hamcrest.CoreMatchers.equalTo;
import static org.hamcrest.CoreMatchers.is;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@QuarkusTest
class SecretManagerResourceTest {

    private void enableSecretManagerService(String projectId) {
        given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/secretmanager.googleapis.com:enable", projectId)
                .then()
                .log()
                .all() // Log the response to see what's happening
                .statusCode(200);
    }

    @Test
    @DisplayName("[POST] /v1/projects/{project}/secrets - creates secret and returns 201")
    void testCreateSecret() {
        String projectId = "create-test-project-" + System.currentTimeMillis();
        String secretId = "create-test-secret-" + System.currentTimeMillis();

        enableSecretManagerService(projectId);

        String requestBody =
                """
            {
              "secretId": "%s",
              "secret": {
                "replication": {
                  "automatic": {}
                }
              }
            }
            """
                        .formatted(secretId);

        given().contentType(ContentType.JSON)
                .body(requestBody)
                .when()
                .post("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(201)
                .body("name", equalTo("projects/%s/secrets/%s".formatted(projectId, secretId)));
    }

    @Test
    @DisplayName("[POST] /v1/projects/{project}/secrets - returns 409 when creating duplicate secret")
    void testCreateDuplicateSecret() {
        String projectId = "duplicate-test-project-" + System.currentTimeMillis();
        String secretId = "duplicate-secret-" + System.currentTimeMillis();

        enableSecretManagerService(projectId);

        String requestBody =
                """
            {
              "secretId": "%s",
              "secret": {
                "replication": {
                  "automatic": {}
                }
              }
            }
            """
                        .formatted(secretId);

        // Create secret first time
        given().contentType(ContentType.JSON)
                .body(requestBody)
                .when()
                .post("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(201);

        // Try to create same secret again
        given().contentType(ContentType.JSON)
                .body(requestBody)
                .when()
                .post("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(409);
    }

    @Test
    @DisplayName("[POST] /v1/projects/{project}/secrets/{secret}/versions - adds version and returns 201")
    void testAddSecretVersion() {
        String projectId = "version-test-project-" + System.currentTimeMillis();
        String secretId = "version-test-secret-" + System.currentTimeMillis();

        enableSecretManagerService(projectId);

        // Create secret first
        String createRequest =
                """
            {
              "secretId": "%s",
              "secret": {
                "replication": {
                  "automatic": {}
                }
              }
            }
            """
                        .formatted(secretId);

        given().contentType(ContentType.JSON)
                .body(createRequest)
                .when()
                .post("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(201);

        // Add version
        String versionRequest =
                """
            {
              "payload": {
                "data": "hello-world"
              }
            }
            """;

        given().contentType(ContentType.JSON)
                .body(versionRequest)
                .when()
                .post("/v1/projects/{project}/secrets/{secret}/addVersion", projectId, secretId)
                .then()
                .statusCode(201)
                .body("name", equalTo("projects/%s/secrets/%s/versions/1".formatted(projectId, secretId)))
                .body("state", equalTo("ENABLED"));
    }

    @Test
    @DisplayName("[POST] /v1/projects/{project}/secrets/{secret}/versions - returns 404 for non-existent secret")
    void testAddVersionToNonExistentSecret() {
        String projectId = "nonexistent-test-project-" + System.currentTimeMillis();
        String secretId = "non-existent-" + System.currentTimeMillis();

        enableSecretManagerService(projectId);

        String versionRequest =
                """
            {
              "payload": {
                "data": "hello-world"
              }
            }
            """;

        given().contentType(ContentType.JSON)
                .body(versionRequest)
                .when()
                .post("/v1/projects/{project}/secrets/{secret}/addVersion", projectId, secretId)
                .then()
                .statusCode(404);
    }

    @Test
    @DisplayName("[GET] /v1/projects/{project}/secrets/{secret}/versions/{version} - returns secret data")
    void testAccessSecretVersion() {
        String projectId = "access-test-project-" + System.currentTimeMillis();
        String secretId = "access-test-secret-" + System.currentTimeMillis();
        String secretData = "secret-data-123";

        // Create secret
        String createRequest =
                """
            {
              "secretId": "%s",
              "secret": {
                "replication": {
                  "automatic": {}
                }
              }
            }
            """
                        .formatted(secretId);

        given().contentType(ContentType.JSON)
                .body(createRequest)
                .when()
                .post("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(201);

        // Add version
        String versionRequest =
                """
            {
              "payload": {
                "data": "%s"
              }
            }
            """
                        .formatted(secretData);

        given().contentType(ContentType.JSON)
                .body(versionRequest)
                .when()
                .post("/v1/projects/{project}/secrets/{secret}/addVersion", projectId, secretId)
                .then()
                .statusCode(201);

        // Access version
        given().when()
                .get("/v1/projects/{project}/secrets/{secret}/versions/{version}/access", projectId, secretId, "1")
                .then()
                .statusCode(200)
                .body("name", equalTo("projects/%s/secrets/%s/versions/1".formatted(projectId, secretId)))
                .body("payload.data", equalTo(secretData));
    }

    @Test
    @DisplayName("[GET] /v1/projects/{project}/secrets/{secret}/versions/latest - returns latest version data")
    void testAccessLatestSecretVersion() {
        String projectId = "latest-test-project-" + System.currentTimeMillis();
        String secretId = "latest-test-secret-" + System.currentTimeMillis();
        String latestData = "latest-secret-data";

        // Create secret
        String createRequest =
                """
            {
              "secretId": "%s",
              "secret": {
                "replication": {
                  "automatic": {}
                }
              }
            }
            """
                        .formatted(secretId);

        given().contentType(ContentType.JSON)
                .body(createRequest)
                .when()
                .post("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(201);

        // Add first version
        given().contentType(ContentType.JSON)
                .body("{\"payload\": {\"data\": \"first-version\"}}")
                .when()
                .post("/v1/projects/{project}/secrets/{secret}/addVersion", projectId, secretId)
                .then()
                .statusCode(201);

        // Add second version
        String latestVersionRequest =
                """
            {
              "payload": {
                "data": "%s"
              }
            }
            """
                        .formatted(latestData);

        given().contentType(ContentType.JSON)
                .body(latestVersionRequest)
                .when()
                .post("/v1/projects/{project}/secrets/{secret}/addVersion", projectId, secretId)
                .then()
                .statusCode(201);

        // Access latest version
        given().when()
                .get("/v1/projects/{project}/secrets/{secret}/versions/{version}/access", projectId, secretId, "latest")
                .then()
                .statusCode(200)
                .body("payload.data", equalTo(latestData));
    }

    @Test
    @DisplayName(
            "[GET] /v1/projects/{project}/secrets/{secret}/versions/{version} - returns 404 for non-existent secret")
    void testAccessNonExistentSecret() {
        String projectId = "notfound-test-project-" + System.currentTimeMillis();
        String secretId = "non-existent-" + System.currentTimeMillis();

        given().when()
                .get("/v1/projects/{project}/secrets/{secret}/versions/{version}/access", projectId, secretId, "1")
                .then()
                .statusCode(404);
    }

    @Test
    @DisplayName("[GET] /v1/projects/{project}/secrets - returns list of secrets for project")
    void testListSecrets() {
        String projectId = "list-test-project-" + System.currentTimeMillis();
        String secret1 = "list-secret-1-" + System.currentTimeMillis();
        String secret2 = "list-secret-2-" + System.currentTimeMillis();

        // Create first secret
        String createRequest1 =
                """
            {
              "secretId": "%s",
              "secret": {
                "replication": {
                  "automatic": {}
                }
              }
            }
            """
                        .formatted(secret1);

        given().contentType(ContentType.JSON)
                .body(createRequest1)
                .when()
                .post("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(201);

        // Create second secret
        String createRequest2 =
                """
            {
              "secretId": "%s",
              "secret": {
                "replication": {
                  "automatic": {}
                }
              }
            }
            """
                        .formatted(secret2);

        given().contentType(ContentType.JSON)
                .body(createRequest2)
                .when()
                .post("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(201);

        // List secrets
        given().when()
                .get("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(200)
                .body("secrets.size()", is(2));
    }

    @Test
    @DisplayName("[GET] /v1/projects/{project}/secrets - returns empty list when no secrets exist")
    void testListSecretsEmptyProject() {
        String projectId = "empty-project-" + System.currentTimeMillis();

        given().when()
                .get("/v1/projects/{project}/secrets", projectId)
                .then()
                .statusCode(200)
                .body("secrets.size()", is(0));
    }
}
