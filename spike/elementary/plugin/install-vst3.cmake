# Best-effort install of the built .vst3 into VST3_COPY_DIR.
# Invoked via `cmake -P` as a POST_BUILD step. NEVER fails the build — the #1
# reason a copy fails is a DAW holding the old .vst3 open; the compile already
# succeeded, so just close the host and rebuild (or copy from build/ by hand).
#
#   -DSRC=<path to built X.vst3 bundle>  -DDST_DIR=<VST3 folder>  -DNAME=<X>

file(MAKE_DIRECTORY "${DST_DIR}")
execute_process(
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${SRC}" "${DST_DIR}/${NAME}.vst3"
  RESULT_VARIABLE rc
  ERROR_VARIABLE err)

if(rc EQUAL 0)
  message(STATUS "installed ${NAME}.vst3 -> ${DST_DIR}")
else()
  message(WARNING
    "could not install ${NAME}.vst3 to ${DST_DIR} (is your DAW holding it open?).\n"
    "  The build succeeded — the fresh bundle is at:\n    ${SRC}\n"
    "  Close the host and rebuild, or copy it there by hand.")
endif()
