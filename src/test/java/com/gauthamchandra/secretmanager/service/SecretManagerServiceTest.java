package com.gauthamchandra.secretmanager.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.gauthamchandra.secretmanager.model.Secret;
import com.gauthamchandra.secretmanager.model.SecretVersion;
import com.gauthamchandra.serviceusage.service.ServiceUsageService;
import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@QuarkusTest
class SecretManagerServiceTest {

    @Inject
    SecretManagerService secretManagerService;

    @Inject
    ServiceUsageService serviceUsageService;

    private static final String SECRET_ID = "test-secret";

    @Test
    @DisplayName("createSecret() - should create a new secret successfully")
    void testCreateSecret() {
        String projectId = "create-test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        Secret secret = secretManagerService.createSecret(projectId, SECRET_ID);

        assertNotNull(secret);
        assertEquals(SECRET_ID, secret.name());
        assertTrue(secret.versions().isEmpty());
    }

    @Test
    @DisplayName("createSecret() - should throw exception when creating duplicate secret")
    void testCreateDuplicateSecret() {
        String projectId = "duplicate-test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        secretManagerService.createSecret(projectId, SECRET_ID);

        assertThrows(IllegalArgumentException.class, () -> secretManagerService.createSecret(projectId, SECRET_ID));
    }

    @Test
    @DisplayName("addSecretVersion() - should add version to existing secret")
    void testAddSecretVersion() {
        String projectId = "add-version-test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        secretManagerService.createSecret(projectId, SECRET_ID);
        String testData = "hello-world";

        SecretVersion version = secretManagerService.addSecretVersion(projectId, SECRET_ID, testData);

        assertNotNull(version);
        assertEquals(1, version.versionNumber());
        assertEquals(testData, version.data());
    }

    @Test
    @DisplayName("addSecretVersion() - should throw exception when adding version to non-existent secret")
    void testAddVersionToNonExistentSecret() {
        String projectId = "nonexistent-secret-test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        assertThrows(
                IllegalArgumentException.class,
                () -> secretManagerService.addSecretVersion(projectId, SECRET_ID, "data"));
    }

    @Test
    @DisplayName("accessSecretVersion() - should access secret version by number")
    void testAccessSecretVersionByNumber() {
        String projectId = "access-version-test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        secretManagerService.createSecret(projectId, SECRET_ID);
        String testData = "hello-world";
        secretManagerService.addSecretVersion(projectId, SECRET_ID, testData);

        SecretVersion version = secretManagerService.accessSecretVersion(projectId, SECRET_ID, "1");

        assertNotNull(version);
        assertEquals(1, version.versionNumber());
        assertEquals(testData, version.data());
    }

    @Test
    @DisplayName("accessSecretVersion() - should access latest secret version")
    void testAccessLatestSecretVersion() {
        String projectId = "access-latest-test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        secretManagerService.createSecret(projectId, SECRET_ID);
        secretManagerService.addSecretVersion(projectId, SECRET_ID, "version-1");
        String latestData = "version-2";
        secretManagerService.addSecretVersion(projectId, SECRET_ID, latestData);

        SecretVersion version = secretManagerService.accessSecretVersion(projectId, SECRET_ID, "latest");

        assertNotNull(version);
        assertEquals(2, version.versionNumber());
        assertEquals(latestData, version.data());
    }

    @Test
    @DisplayName("accessSecretVersion() - should throw exception when accessing non-existent secret")
    void testAccessNonExistentSecret() {
        String projectId = "nonexistent-secret-access-test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        assertThrows(
                IllegalArgumentException.class,
                () -> secretManagerService.accessSecretVersion(projectId, SECRET_ID, "1"));
    }

    @Test
    @DisplayName("accessSecretVersion() - should throw exception when accessing non-existent version")
    void testAccessNonExistentVersion() {
        String projectId = "nonexistent-version-test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        secretManagerService.createSecret(projectId, SECRET_ID);

        assertThrows(
                IllegalArgumentException.class,
                () -> secretManagerService.accessSecretVersion(projectId, SECRET_ID, "1"));
    }

    @Test
    @DisplayName("listSecrets() - should list secrets for a project")
    void testListSecrets() {
        String projectId = "list-secrets-test-project";
        String otherProjectId = "other-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");
        serviceUsageService.enableService(otherProjectId, "secretmanager.googleapis.com");

        secretManagerService.createSecret(projectId, "secret-1");
        secretManagerService.createSecret(projectId, "secret-2");
        secretManagerService.createSecret(otherProjectId, "secret-3");

        List<Secret> secrets = secretManagerService.listSecrets(projectId);

        assertEquals(2, secrets.size());
        assertTrue(secrets.stream().anyMatch(s -> s.name().equals("secret-1")));
        assertTrue(secrets.stream().anyMatch(s -> s.name().equals("secret-2")));
    }

    @Test
    @DisplayName("listSecrets() - should return empty list when no secrets exist for project")
    void testListSecretsEmptyProject() {
        // Enable service for the empty project too
        serviceUsageService.enableService("empty-project", "secretmanager.googleapis.com");

        List<Secret> secrets = secretManagerService.listSecrets("empty-project");

        assertTrue(secrets.isEmpty());
    }

    @Test
    @DisplayName("createSecret() - should throw exception when service is disabled")
    void testCreateSecretWhenServiceDisabled() {
        String disabledProject = "disabled-project";
        // Don't enable the service for this project

        IllegalArgumentException exception = assertThrows(
                IllegalArgumentException.class, () -> secretManagerService.createSecret(disabledProject, SECRET_ID));

        assertTrue(exception.getMessage().contains("is not enabled"));
    }
}
