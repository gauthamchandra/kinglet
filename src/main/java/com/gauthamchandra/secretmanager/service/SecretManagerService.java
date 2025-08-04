package com.gauthamchandra.secretmanager.service;

import com.gauthamchandra.secretmanager.model.Secret;
import com.gauthamchandra.secretmanager.model.SecretVersion;
import com.gauthamchandra.serviceusage.service.ServiceUsageService;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@ApplicationScoped
public class SecretManagerService {

    private final Map<String, Secret> secrets = new ConcurrentHashMap<>();
    private static final String SECRET_MANAGER_SERVICE = "secretmanager.googleapis.com";

    @Inject
    ServiceUsageService serviceUsageService;

    public Secret createSecret(String projectId, String secretId) {
        serviceUsageService.validateServiceAccess(projectId, SECRET_MANAGER_SERVICE);
        String key = createKey(projectId, secretId);
        if (secrets.containsKey(key)) {
            throw new IllegalArgumentException("Secret already exists");
        }
        Secret secret = Secret.create(secretId);
        secrets.put(key, secret);
        return secret;
    }

    public Secret createSecret(String projectId, String secretId, Map<String, String> labels) {
        serviceUsageService.validateServiceAccess(projectId, SECRET_MANAGER_SERVICE);
        String key = createKey(projectId, secretId);
        if (secrets.containsKey(key)) {
            throw new IllegalArgumentException("Secret already exists");
        }
        Secret secret = Secret.create(secretId, labels);
        secrets.put(key, secret);
        return secret;
    }

    public Secret getSecret(String projectId, String secretId) {
        serviceUsageService.validateServiceAccess(projectId, SECRET_MANAGER_SERVICE);
        String key = createKey(projectId, secretId);
        Secret secret = secrets.get(key);
        if (secret == null) {
            throw new IllegalArgumentException("Secret not found");
        }
        return secret;
    }

    public void deleteSecret(String projectId, String secretId) {
        serviceUsageService.validateServiceAccess(projectId, SECRET_MANAGER_SERVICE);
        String key = createKey(projectId, secretId);
        if (!secrets.containsKey(key)) {
            throw new IllegalArgumentException("Secret not found");
        }
        secrets.remove(key);
    }

    public Secret updateSecret(String projectId, String secretId, Map<String, String> labels) {
        String key = createKey(projectId, secretId);
        Secret secret = secrets.get(key);
        if (secret == null) {
            throw new IllegalArgumentException("Secret not found");
        }
        Secret updatedSecret = secret.withLabels(labels);
        secrets.put(key, updatedSecret);
        return updatedSecret;
    }

    public SecretVersion addSecretVersion(String projectId, String secretId, String data) {
        serviceUsageService.validateServiceAccess(projectId, SECRET_MANAGER_SERVICE);
        String key = createKey(projectId, secretId);
        Secret secret = secrets.get(key);
        if (secret == null) {
            throw new IllegalArgumentException("Secret not found");
        }
        return secret.addVersion(data);
    }

    public SecretVersion accessSecretVersion(String projectId, String secretId, String versionId) {
        serviceUsageService.validateServiceAccess(projectId, SECRET_MANAGER_SERVICE);
        String key = createKey(projectId, secretId);
        Secret secret = secrets.get(key);
        if (secret == null) {
            throw new IllegalArgumentException("Secret not found");
        }

        SecretVersion version = secret.getVersion(versionId);
        if (version == null) {
            throw new IllegalArgumentException("Version not found");
        }

        if (!version.isAccessible()) {
            throw new IllegalArgumentException("Version is not accessible");
        }

        return version;
    }

    public SecretVersion getSecretVersion(String projectId, String secretId, String versionId) {
        String key = createKey(projectId, secretId);
        Secret secret = secrets.get(key);
        if (secret == null) {
            throw new IllegalArgumentException("Secret not found");
        }

        SecretVersion version = secret.getVersion(versionId);
        if (version == null) {
            throw new IllegalArgumentException("Version not found");
        }

        return version;
    }

    public List<SecretVersion> listSecretVersions(String projectId, String secretId) {
        String key = createKey(projectId, secretId);
        Secret secret = secrets.get(key);
        if (secret == null) {
            throw new IllegalArgumentException("Secret not found");
        }

        return secret.versions().values().stream()
                .sorted((v1, v2) -> Integer.compare(v2.versionNumber(), v1.versionNumber()))
                .collect(Collectors.toList());
    }

    public SecretVersion disableSecretVersion(String projectId, String secretId, String versionId) {
        return updateVersionState(projectId, secretId, versionId, SecretVersion.VersionState.DISABLED);
    }

    public SecretVersion enableSecretVersion(String projectId, String secretId, String versionId) {
        return updateVersionState(projectId, secretId, versionId, SecretVersion.VersionState.ENABLED);
    }

    public SecretVersion destroySecretVersion(String projectId, String secretId, String versionId) {
        return updateVersionState(projectId, secretId, versionId, SecretVersion.VersionState.DESTROYED);
    }

    public List<Secret> listSecrets(String projectId) {
        serviceUsageService.validateServiceAccess(projectId, SECRET_MANAGER_SERVICE);
        String prefix = projectId + ":";
        return secrets.entrySet().stream()
                .filter(entry -> entry.getKey().startsWith(prefix))
                .map(Map.Entry::getValue)
                .toList();
    }

    public List<Secret> listSecrets(String projectId, String filter) {
        if (filter == null || filter.trim().isEmpty()) {
            return listSecrets(projectId);
        }

        String prefix = projectId + ":";
        return secrets.entrySet().stream()
                .filter(entry -> entry.getKey().startsWith(prefix))
                .map(Map.Entry::getValue)
                .filter(secret -> matchesFilter(secret, filter))
                .toList();
    }

    private SecretVersion updateVersionState(
            String projectId, String secretId, String versionId, SecretVersion.VersionState newState) {
        String key = createKey(projectId, secretId);
        Secret secret = secrets.get(key);
        if (secret == null) {
            throw new IllegalArgumentException("Secret not found");
        }

        int versionNumber;
        try {
            versionNumber = Integer.parseInt(versionId);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Invalid version format");
        }

        SecretVersion updatedVersion = secret.updateVersionState(versionNumber, newState);
        if (updatedVersion == null) {
            throw new IllegalArgumentException("Version not found");
        }

        return updatedVersion;
    }

    private boolean matchesFilter(Secret secret, String filter) {
        return secret.name().toLowerCase().contains(filter.toLowerCase())
                || secret.labels().values().stream()
                        .anyMatch(label -> label.toLowerCase().contains(filter.toLowerCase()));
    }

    private String createKey(String projectId, String secretId) {
        return projectId + ":" + secretId;
    }
}
