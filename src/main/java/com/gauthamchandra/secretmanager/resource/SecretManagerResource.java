package com.gauthamchandra.secretmanager.resource;

import com.gauthamchandra.secretmanager.api.DefaultApi;
import com.gauthamchandra.secretmanager.model.Secret;
import com.gauthamchandra.secretmanager.model.SecretVersion;
import com.gauthamchandra.secretmanager.model.generated.AccessSecretVersionResponse;
import com.gauthamchandra.secretmanager.model.generated.AddSecretVersionRequest;
import com.gauthamchandra.secretmanager.model.generated.CreateSecretRequest;
import com.gauthamchandra.secretmanager.model.generated.ListSecretVersionsResponse;
import com.gauthamchandra.secretmanager.model.generated.ListSecretsResponse;
import com.gauthamchandra.secretmanager.model.generated.SecretPayload;
import com.gauthamchandra.secretmanager.model.generated.UpdateSecretRequest;
import com.gauthamchandra.secretmanager.service.SecretManagerService;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.Path;
import java.util.List;
import java.util.Map;

@RequestScoped
@Path("/projects/{project}/secrets")
public class SecretManagerResource implements DefaultApi {

    @Inject
    SecretManagerService secretManagerService;

    @Override
    public AccessSecretVersionResponse accessSecretVersion(String project, String secretId, String versionId) {
        try {
            SecretVersion secretVersion = secretManagerService.accessSecretVersion(project, secretId, versionId);
            return createAccessSecretVersionResponse(project, secretId, secretVersion);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret or version not found");
        }
    }

    @Override
    public com.gauthamchandra.secretmanager.model.generated.SecretVersion addSecretVersion(
            String project, String secretId, AddSecretVersionRequest addSecretVersionRequest) {
        try {
            String data = addSecretVersionRequest.getPayload().getData();
            SecretVersion version = secretManagerService.addSecretVersion(project, secretId, data);
            return createSecretVersionResponse(project, secretId, version);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret not found");
        }
    }

    @Override
    public com.gauthamchandra.secretmanager.model.generated.Secret createSecret(
            String project, CreateSecretRequest createSecretRequest) {
        try {
            String secretId = createSecretRequest.getSecretId();
            Map<String, String> labels = createSecretRequest.getSecret() != null
                            && createSecretRequest.getSecret().getLabels() != null
                    ? createSecretRequest.getSecret().getLabels()
                    : Map.of();
            Secret secret = secretManagerService.createSecret(project, secretId, labels);
            return createSecretResponse(project, secret);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.BadRequestException("Secret already exists");
        }
    }

    @Override
    public ListSecretsResponse listSecrets(String project, Integer pageSize, String pageToken, String filter) {
        List<Secret> secrets = secretManagerService.listSecrets(project, filter);
        List<com.gauthamchandra.secretmanager.model.generated.Secret> secretResponses = secrets.stream()
                .map(secret -> createSecretResponse(project, secret))
                .toList();

        return new ListSecretsResponse().secrets(secretResponses).totalSize(secretResponses.size());
    }

    @Override
    public com.gauthamchandra.secretmanager.model.generated.Secret getSecret(String project, String secretId) {
        try {
            Secret secret = secretManagerService.getSecret(project, secretId);
            return createSecretResponse(project, secret);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret not found");
        }
    }

    @Override
    public void deleteSecret(String project, String secretId) {
        try {
            secretManagerService.deleteSecret(project, secretId);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret not found");
        }
    }

    @Override
    public com.gauthamchandra.secretmanager.model.generated.Secret updateSecret(
            String project, String secretId, UpdateSecretRequest updateSecretRequest) {
        try {
            Map<String, String> labels = updateSecretRequest.getSecret() != null
                            && updateSecretRequest.getSecret().getLabels() != null
                    ? updateSecretRequest.getSecret().getLabels()
                    : Map.of();
            Secret updatedSecret = secretManagerService.updateSecret(project, secretId, labels);
            return createSecretResponse(project, updatedSecret);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret not found");
        }
    }

    @Override
    public ListSecretVersionsResponse listSecretVersions(
            String project, String secretId, Integer pageSize, String pageToken) {
        try {
            List<SecretVersion> versions = secretManagerService.listSecretVersions(project, secretId);
            List<com.gauthamchandra.secretmanager.model.generated.SecretVersion> versionResponses = versions.stream()
                    .map(version -> createSecretVersionResponse(project, secretId, version))
                    .toList();

            return new ListSecretVersionsResponse().versions(versionResponses).totalSize(versionResponses.size());
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret not found");
        }
    }

    @Override
    public com.gauthamchandra.secretmanager.model.generated.SecretVersion getSecretVersion(
            String project, String secretId, String versionId) {
        try {
            SecretVersion version = secretManagerService.getSecretVersion(project, secretId, versionId);
            return createSecretVersionResponse(project, secretId, version);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret or version not found");
        }
    }

    @Override
    public com.gauthamchandra.secretmanager.model.generated.SecretVersion disableSecretVersion(
            String project, String secretId, String versionId, Object body) {
        try {
            SecretVersion version = secretManagerService.disableSecretVersion(project, secretId, versionId);
            return createSecretVersionResponse(project, secretId, version);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret or version not found");
        }
    }

    @Override
    public com.gauthamchandra.secretmanager.model.generated.SecretVersion enableSecretVersion(
            String project, String secretId, String versionId, Object body) {
        try {
            SecretVersion version = secretManagerService.enableSecretVersion(project, secretId, versionId);
            return createSecretVersionResponse(project, secretId, version);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret or version not found");
        }
    }

    @Override
    public com.gauthamchandra.secretmanager.model.generated.SecretVersion destroySecretVersion(
            String project, String secretId, String versionId, Object body) {
        try {
            SecretVersion version = secretManagerService.destroySecretVersion(project, secretId, versionId);
            return createSecretVersionResponse(project, secretId, version);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Secret or version not found");
        }
    }

    private AccessSecretVersionResponse createAccessSecretVersionResponse(
            String project, String secretId, SecretVersion version) {
        String name = version.getName(project, secretId);
        SecretPayload payload = new SecretPayload().data(version.data());
        return new AccessSecretVersionResponse().name(name).payload(payload);
    }

    private com.gauthamchandra.secretmanager.model.generated.SecretVersion createSecretVersionResponse(
            String project, String secretId, SecretVersion version) {
        String name = version.getName(project, secretId);
        return new com.gauthamchandra.secretmanager.model.generated.SecretVersion()
                .name(name)
                .createTime(version.createTime())
                .destroyTime(version.destroyTime())
                .state(convertVersionState(version.state()));
    }

    private com.gauthamchandra.secretmanager.model.generated.Secret createSecretResponse(
            String project, Secret secret) {
        String name = secret.getResourceName(project);
        return new com.gauthamchandra.secretmanager.model.generated.Secret()
                .name(name)
                .createTime(secret.createTime())
                .labels(secret.labels());
    }

    private com.gauthamchandra.secretmanager.model.generated.SecretVersion.StateEnum convertVersionState(
            SecretVersion.VersionState state) {
        return switch (state) {
            case ENABLED -> com.gauthamchandra.secretmanager.model.generated.SecretVersion.StateEnum.ENABLED;
            case DISABLED -> com.gauthamchandra.secretmanager.model.generated.SecretVersion.StateEnum.DISABLED;
            case DESTROYED -> com.gauthamchandra.secretmanager.model.generated.SecretVersion.StateEnum.DESTROYED;
        };
    }
}
