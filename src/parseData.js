import {fromArrayBuffer, fromUrl, fromBlob} from 'geotiff';
import {getPalette} from 'geotiff-palette';
import calcImageStats from 'calc-image-stats';
import {unflatten} from './utils.js';

function processResult(result) {
  const stats = calcImageStats(result.values, {
    height: result.height,
    layout: '[band][row][column]',
    noData: result.noDataValue,
    precise: false,
    stats: ['max', 'min', 'range'],
    width: result.width,
  });

  result.maxs = stats.bands.map(band => band.max);
  result.mins = stats.bands.map(band => band.min);
  result.ranges = stats.bands.map(band => band.range);

  return result;
}

// Copied from : https://github.com/geotiffjs/geotiff.js/blob/master/src/geotiffimage.js#L906
function getBoundingBox(image, tilegrid = false) {
  const height = image.getHeight();
  const width = image.getWidth();
  const fileDirectory = image.fileDirectory;

  if (fileDirectory.ModelTransformation && !tilegrid) {
    // eslint-disable-next-line no-unused-vars
    const [a, b, c, d, e, f, g, h] = fileDirectory.ModelTransformation;

    const corners = [
      [0, 0],
      [0, height],
      [width, 0],
      [width, height],
    ];

    const projected = corners.map(([I, J]) => [
      d + (a * I) + (b * J),
      h + (e * I) + (f * J),
    ]);

    const xs = projected.map((pt) => pt[0]);
    const ys = projected.map((pt) => pt[1]);

    return [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
  } else {
    const origin = image.getOrigin();
    const resolution = image.getResolution();

    const x1 = origin[0];
    const y1 = origin[1];

    const x2 = x1 + (resolution[0] * width);
    const y2 = y1 + (resolution[1] * height);

    return [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ];
  }
}

/* We're not using async because trying to avoid dependency on babel's polyfill
There can be conflicts when GeoRaster is used in another project that is also
using @babel/polyfill */
export default function parseData(data, debug) {
  return new Promise((resolve, reject) => {
    try {
      if (debug) console.log('starting parseData with', data);
      if (debug) console.log('\tGeoTIFF:', typeof GeoTIFF);

      const result = {};

      let height, width;

      if (data.rasterType === 'object') {
        result.values = data.data;
        result.height = height = data.metadata.height || result.values[0].length;
        result.width = width = data.metadata.width || result.values[0][0].length;
        result.pixelHeight = data.metadata.pixelHeight;
        result.pixelWidth = data.metadata.pixelWidth;
        result.projection = data.metadata.projection;
        result.xmin = data.metadata.xmin;
        result.ymax = data.metadata.ymax;
        result.noDataValue = data.metadata.noDataValue;
        result.numberOfRasters = result.values.length;
        result.xmax = result.xmin + result.width * result.pixelWidth;
        result.ymin = result.ymax - result.height * result.pixelHeight;
        result._data = null;
        resolve(processResult(result));
      } else if (data.rasterType === 'geotiff') {
        result._data = data.data;
        const initArgs = [data.data];
        let initFunction = fromArrayBuffer;
        if (data.sourceType === 'url') {
          initFunction = fromUrl;
          initArgs.push(data.options);
        } else if (data.sourceType === 'Blob') {
          initFunction = fromBlob;
        }

        if (debug) console.log('data.rasterType is geotiff');
        resolve(initFunction(...initArgs).then(geotiff => {
          if (debug) console.log('geotiff:', geotiff);
          return geotiff.getImage().then(image => {
            try {
              if (debug) console.log('image:', image);

              const fileDirectory = image.fileDirectory;

              const {
                GeographicTypeGeoKey,
                ProjectedCSTypeGeoKey,
              } = (image.getGeoKeys() || {});

              result.projection = ProjectedCSTypeGeoKey || GeographicTypeGeoKey || data.metadata.projection;
              if (debug) console.log('projection:', result.projection);

              result.height = height = image.getHeight();
              if (debug) console.log('result.height:', result.height);
              result.width = width = image.getWidth();
              if (debug) console.log('result.width:', result.width);

              const [resolutionX, resolutionY] = image.getResolution();
              result.pixelHeight = Math.abs(resolutionY);
              result.pixelWidth = Math.abs(resolutionX);

              const [xmin, ymin, xmax, ymax] = getBoundingBox(image);

              if (debug) console.log('bounding box:', [xmin, ymin, xmax, ymax]);

              result.xmin = xmin;
              result.xmax = xmax;
              result.ymax = ymax;
              result.ymin = ymin;

              result.noDataValue = fileDirectory.GDAL_NODATA ? parseFloat(fileDirectory.GDAL_NODATA) : null;

              result.numberOfRasters = fileDirectory.SamplesPerPixel;

              if (fileDirectory.ColorMap) {
                result.palette = getPalette(image);
              }

              if (!data.readOnDemand) {
                return image.readRasters().then(rasters => {
                  result.values = rasters.map(valuesInOneDimension => {
                    return unflatten(valuesInOneDimension, {height, width});
                  });
                  return processResult(result);
                });
              } else {
                result._geotiff = geotiff;
                return result;
              }
            } catch (error) {
              reject(error);
              console.error('[georaster] error parsing georaster:', error);
            }
          });
        }));
      }
    } catch (error) {
      reject(error);
      console.error('[georaster] error parsing georaster:', error);
    }
  });
}
