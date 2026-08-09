#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/memfd.h>
#include <linux/openat2.h>
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static int strict_absolute_path(const char *path, size_t length) {
  if (length < 2 || path[0] != '/' || path[length - 1] == '/') return 0;
  if (strstr(path, "//") != NULL || strstr(path, "/./") != NULL ||
      strstr(path, "/../") != NULL) return 0;
  if (length >= 2 && strcmp(path + length - 2, "/.") == 0) return 0;
  if (length >= 3 && strcmp(path + length - 3, "/..") == 0) return 0;
  return 1;
}

static napi_value ancestor_identities(napi_env env, int root_fd,
                                      int source_parent_fd) {
  int current_fd = fcntl(source_parent_fd, F_DUPFD_CLOEXEC, 3);
  if (current_fd < 0) return fail(env, "ancestor parent open failed");

  struct stat root_stat;
  if (fstat(root_fd, &root_stat) != 0) {
    close(current_fd);
    return fail(env, "ancestor root stat failed");
  }
  napi_value output;
  if (napi_create_array(env, &output) != napi_ok) {
    close(current_fd);
    return fail(env, "ancestor array creation failed");
  }
  for (uint32_t index = 0; index < 256; index++) {
    struct stat value;
    if (fstat(current_fd, &value) != 0) {
      close(current_fd);
      return fail(env, "ancestor stat failed");
    }
    char identity[96];
    int length = snprintf(identity, sizeof(identity), "%" PRIu64 ":%" PRIu64,
                          (uint64_t)value.st_dev, (uint64_t)value.st_ino);
    napi_value item;
    if (length <= 0 || (size_t)length >= sizeof(identity) ||
        napi_create_string_utf8(env, identity, (size_t)length, &item) !=
            napi_ok ||
        napi_set_element(env, output, index, item) != napi_ok) {
      close(current_fd);
      return fail(env, "ancestor identity creation failed");
    }
    if (value.st_dev == root_stat.st_dev && value.st_ino == root_stat.st_ino) {
      close(current_fd);
      return output;
    }
    int parent_fd = openat(current_fd, "..", O_PATH | O_DIRECTORY | O_CLOEXEC |
                                                   O_NOFOLLOW);
    close(current_fd);
    if (parent_fd < 0) return fail(env, "ancestor walk failed");
    current_fd = parent_fd;
  }
  close(current_fd);
  return fail(env, "ancestor depth exceeded");
}

static napi_value open_source(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 2) {
    return fail(env, "openSource requires path and source kind");
  }

  size_t path_length = 0;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &path_length) !=
          napi_ok ||
      path_length == 0 || path_length > 4096) {
    return fail(env, "openSource path is invalid");
  }
  char *path = calloc(path_length + 1, 1);
  if (path == NULL) return fail(env, "openSource allocation failed");
  if (napi_get_value_string_utf8(env, argv[0], path, path_length + 1,
                                 &path_length) != napi_ok ||
      !strict_absolute_path(path, path_length)) {
    free(path);
    return fail(env, "openSource path is not strict absolute syntax");
  }

  size_t kind_length = 0;
  char kind[16] = {0};
  if (napi_get_value_string_utf8(env, argv[1], kind, sizeof(kind),
                                 &kind_length) != napi_ok ||
      (strcmp(kind, "file") != 0 && strcmp(kind, "directory") != 0)) {
    free(path);
    return fail(env, "openSource kind is invalid");
  }

  int root_fd = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (root_fd < 0) {
    free(path);
    return fail(env, "openSource root open failed");
  }
  char *slash = strrchr(path, '/');
  if (slash == NULL || slash[1] == '\0') {
    close(root_fd);
    free(path);
    return fail(env, "openSource path split failed");
  }
  const char *basename = slash + 1;
  int parent_fd = -1;
  if (slash == path) {
    parent_fd = fcntl(root_fd, F_DUPFD_CLOEXEC, 3);
  } else {
    *slash = '\0';
    struct open_how parent_how = {
        .flags = O_PATH | O_DIRECTORY | O_CLOEXEC,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                   RESOLVE_NO_MAGICLINKS,
    };
    parent_fd = (int)syscall(SYS_openat2, root_fd, path + 1, &parent_how,
                             sizeof(parent_how));
  }
  if (parent_fd < 0) {
    close(root_fd);
    free(path);
    return fail(env, "openSource parent resolution failed");
  }

  napi_value ancestors = ancestor_identities(env, root_fd, parent_fd);
  if (ancestors == NULL) {
    close(parent_fd);
    close(root_fd);
    free(path);
    return NULL;
  }

  int file_kind = strcmp(kind, "file") == 0;
  struct open_how how = {
      .flags = (uint64_t)(file_kind ? O_RDONLY | O_CLOEXEC
                                    : O_PATH | O_DIRECTORY | O_CLOEXEC),
      .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                 RESOLVE_NO_MAGICLINKS,
  };
  int fd = (int)syscall(SYS_openat2, parent_fd, basename, &how, sizeof(how));
  close(parent_fd);
  if (fd < 0) {
    close(root_fd);
    free(path);
    return fail(env, "openSource secure resolution failed");
  }

  struct stat stat_value;
  if (fstat(fd, &stat_value) != 0 ||
      (strcmp(kind, "file") == 0 && !S_ISREG(stat_value.st_mode)) ||
      (strcmp(kind, "directory") == 0 && !S_ISDIR(stat_value.st_mode))) {
    close(fd);
    close(root_fd);
    free(path);
    return fail(env, "openSource type validation failed");
  }

  close(root_fd);
  free(path);

  napi_value result;
  napi_value value;
  napi_create_object(env, &result);
  napi_create_int32(env, fd, &value);
  napi_set_named_property(env, result, "fd", value);
  napi_create_bigint_uint64(env, (uint64_t)stat_value.st_dev, &value);
  napi_set_named_property(env, result, "device", value);
  napi_create_bigint_uint64(env, (uint64_t)stat_value.st_ino, &value);
  napi_set_named_property(env, result, "inode", value);
  napi_create_uint32(env, (uint32_t)stat_value.st_mode, &value);
  napi_set_named_property(env, result, "mode", value);
  napi_create_bigint_uint64(env, (uint64_t)stat_value.st_nlink, &value);
  napi_set_named_property(env, result, "linkCount", value);
  napi_create_uint32(env, (uint32_t)stat_value.st_uid, &value);
  napi_set_named_property(env, result, "ownerUid", value);
  napi_create_uint32(env, (uint32_t)stat_value.st_gid, &value);
  napi_set_named_property(env, result, "ownerGid", value);
  napi_create_bigint_uint64(env, (uint64_t)stat_value.st_size, &value);
  napi_set_named_property(env, result, "size", value);
  napi_set_named_property(env, result, "ancestorIdentities", ancestors);
  return result;
}

static napi_value seal_executable(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  int32_t source_fd = -1;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || napi_get_value_int32(env, argv[0], &source_fd) != napi_ok ||
      source_fd < 0) {
    return fail(env, "sealExecutable requires one source descriptor");
  }
  struct stat source;
  if (fstat(source_fd, &source) != 0 || !S_ISREG(source.st_mode) ||
      source.st_size < 1 || source.st_size > 16 * 1024 * 1024 ||
      (source.st_mode & 0111) == 0) {
    return fail(env, "sealExecutable source is invalid");
  }
  int output_fd = (int)syscall(SYS_memfd_create, "hitch-secure-launcher",
                               MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (output_fd < 0) return fail(env, "sealExecutable memfd creation failed");
  uint8_t buffer[65536];
  off_t position = 0;
  while (position < source.st_size) {
    size_t wanted = (size_t)(source.st_size - position);
    if (wanted > sizeof(buffer)) wanted = sizeof(buffer);
    ssize_t count = pread(source_fd, buffer, wanted, position);
    if (count <= 0) {
      close(output_fd);
      return fail(env, "sealExecutable source read failed");
    }
    size_t written = 0;
    while (written < (size_t)count) {
      ssize_t result =
          write(output_fd, buffer + written, (size_t)count - written);
      if (result <= 0) {
        close(output_fd);
        return fail(env, "sealExecutable copy failed");
      }
      written += (size_t)result;
    }
    position += count;
  }
  if (lseek(output_fd, 0, SEEK_SET) != 0 || fchmod(output_fd, 0555) != 0 ||
      fcntl(output_fd, F_ADD_SEALS,
            F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL) != 0) {
    close(output_fd);
    return fail(env, "sealExecutable sealing failed");
  }
  struct stat output;
  if (fstat(output_fd, &output) != 0) {
    close(output_fd);
    return fail(env, "sealExecutable stat failed");
  }
  napi_value result;
  napi_value value;
  napi_create_object(env, &result);
  napi_create_int32(env, output_fd, &value);
  napi_set_named_property(env, result, "fd", value);
  napi_create_bigint_uint64(env, (uint64_t)output.st_dev, &value);
  napi_set_named_property(env, result, "device", value);
  napi_create_bigint_uint64(env, (uint64_t)output.st_ino, &value);
  napi_set_named_property(env, result, "inode", value);
  napi_create_uint32(env, (uint32_t)output.st_mode, &value);
  napi_set_named_property(env, result, "mode", value);
  napi_create_bigint_uint64(env, (uint64_t)output.st_size, &value);
  napi_set_named_property(env, result, "size", value);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "openSource", NAPI_AUTO_LENGTH, open_source, NULL,
                       &function);
  napi_set_named_property(env, exports, "openSource", function);
  napi_create_function(env, "sealExecutable", NAPI_AUTO_LENGTH,
                       seal_executable, NULL, &function);
  napi_set_named_property(env, exports, "sealExecutable", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
